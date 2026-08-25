"use strict"

function withoutPriorAdvisoryInput(part) {
  const state = part.state && typeof part.state === "object" ? part.state : {}
  const filteredState = { ...state }
  delete filteredState.input
  delete filteredState.metadata
  return { ...part, state: filteredState }
}

export function buildSessionContext({
  session,
  currentMessageID,
  task,
  executorSystemPrompt,
  advisorToolDescription,
}) {
  if (!session || !Array.isArray(session.messages)) {
    throw new Error("opencode session export does not contain a messages array")
  }

  const messages = session.messages.map((message) => {
    const info = message && typeof message.info === "object" ? message.info : {}
    const parts = Array.isArray(message?.parts) ? message.parts : []
    return {
      info,
      parts: parts.flatMap((part) => {
        if (!part || typeof part !== "object") return []
        if (part.type !== "tool" || part.tool !== "advisory") return [part]

        const messageID = part.messageID || info.id
        const status = part.state?.status
        if (messageID === currentMessageID && status !== "completed" && status !== "error") {
          return []
        }
        return [withoutPriorAdvisoryInput(part)]
      }),
    }
  })

  return {
    schema_version: 1,
    task,
    executor_system_prompt: executorSystemPrompt || null,
    advisor_tool_description: advisorToolDescription,
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
