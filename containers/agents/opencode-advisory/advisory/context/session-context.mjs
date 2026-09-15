"use strict"

function modelVisibleMessages(messages) {
  const retained = []
  const completedCompactions = new Set()

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== "object") continue
    retained.push(message)

    const info = message.info && typeof message.info === "object" ? message.info : {}
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (
      info.role === "user" &&
      completedCompactions.has(info.id) &&
      parts.some((part) => part?.type === "compaction")
    ) {
      break
    }
    if (info.role === "assistant" && info.summary && info.finish && !info.error) {
      completedCompactions.add(info.parentID)
    }
  }

  return retained.reverse()
}

function compactUserMessage(message) {
  const content = []
  const attachments = []
  for (const part of message.parts) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && !part.ignored && typeof part.text === "string") {
      content.push(part.text)
    }
    if (part.type === "compaction") content.push("What did we do so far?")
    if (part.type === "subtask") content.push("The following tool was executed by the user")
    if (
      part.type === "file" &&
      part.mime !== "text/plain" &&
      part.mime !== "application/x-directory"
    ) {
      attachments.push({
        mime: part.mime,
        ...(part.filename ? { filename: part.filename } : {}),
        url: part.url,
      })
    }
  }
  if (content.length === 0 && attachments.length === 0) return []
  return [{
    role: "user",
    ...(content.length > 0 ? { content: content.join("\n\n") } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  }]
}

function compactAssistantMessage(message, currentMessageID) {
  if (
    message.info.error &&
    !(
      message.info.error.name === "MessageAbortedError" &&
      message.parts.some((part) => part?.type !== "step-start" && part?.type !== "reasoning")
    )
  ) {
    return []
  }

  const content = []
  const reasoning = []
  const toolCalls = []
  const toolResults = []

  for (const part of message.parts) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") content.push(part.text)
    if (part.type === "reasoning" && typeof part.text === "string") reasoning.push(part.text)
    if (part.type !== "tool") continue

    const state = part.state && typeof part.state === "object" ? part.state : {}
    const messageID = part.messageID || message.info.id
    if (
      part.tool === "advisory" &&
      messageID === currentMessageID &&
      state.status !== "completed" &&
      state.status !== "error"
    ) {
      continue
    }

    toolCalls.push({
      name: part.tool,
      ...(part.tool !== "advisory" && state.input !== undefined ? { input: state.input } : {}),
    })

    const result = { role: "tool", name: part.tool, status: state.status }
    if (state.status === "completed") {
      result.content = state.time?.compacted ? "[Old tool result content cleared]" : state.output
    } else if (state.status === "error") {
      if (state.metadata?.interrupted === true && typeof state.metadata.output === "string") {
        result.content = state.metadata.output
      } else {
        result.error = state.error
      }
    } else {
      result.error = "[Tool execution was interrupted]"
    }
    toolResults.push(result)
  }

  const compacted = []
  if (content.length > 0 || reasoning.length > 0 || toolCalls.length > 0) {
    compacted.push({
      role: "assistant",
      ...(content.length > 0 ? { content: content.join("\n\n") } : {}),
      ...(reasoning.length > 0 ? { reasoning: reasoning.join("\n\n") } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }
  compacted.push(...toolResults)
  return compacted
}

export function buildSessionContext({ session, currentMessageID, executorSystemPrompt }) {
  if (!session || !Array.isArray(session.messages)) {
    throw new Error("opencode session export does not contain a messages array")
  }

  const messages = modelVisibleMessages(session.messages).flatMap((message) => {
    const info = message.info && typeof message.info === "object" ? message.info : {}
    const withParts = {
      info,
      parts: Array.isArray(message.parts) ? message.parts : [],
    }
    if (info.role === "user") return compactUserMessage(withParts)
    if (info.role === "assistant") return compactAssistantMessage(withParts, currentMessageID)
    return []
  })

  return {
    schema_version: 2,
    executor_system_prompt: executorSystemPrompt || null,
    messages,
  }
}

export function serializeSessionContext(options, maxBytes = 0) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES must be a non-negative integer")
  }
  const serialized = JSON.stringify(buildSessionContext(options))
  const size = Buffer.byteLength(serialized, "utf8")
  if (maxBytes > 0 && size > maxBytes) {
    throw new Error(
      `full advisor context is ${size} bytes, exceeding EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES=${maxBytes}; increase the limit or use agent-provided context`,
    )
  }
  return serialized
}
