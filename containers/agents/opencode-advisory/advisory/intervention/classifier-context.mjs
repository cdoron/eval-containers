"use strict"

import crypto from "node:crypto"
import {
  PLATFORM_ADVISOR_MESSAGE_PREFIX,
  isAutomatedAdvisorCallID,
  isSuccessfulAutomatedAdvisorResult,
  rewriteAutomatedAdvisorMessages,
} from "./protocol.mjs"

function stringifyContent(content) {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  return JSON.stringify(content)
}

function truncateStart(value, maxCharacters) {
  if (value.length <= maxCharacters) return { value, truncated: false }
  return { value: `${value.slice(0, maxCharacters)}\n[message truncated]`, truncated: true }
}

function truncateHeadTail(value, maxCharacters, label) {
  if (value.length <= maxCharacters) return { value, truncated: false, original_characters: value.length }
  const marker = `\n[${label} truncated; original characters: ${value.length}]\n`
  const available = Math.max(0, maxCharacters - marker.length)
  const headCharacters = Math.ceil(available / 2)
  const tailCharacters = Math.floor(available / 2)
  return {
    value: `${value.slice(0, headCharacters)}${marker}${value.slice(value.length - tailCharacters)}`,
    truncated: true,
    original_characters: value.length,
  }
}

function messageText(message, maxStringCharacters) {
  const parts = []
  if (message.content !== undefined && message.content !== null && message.content !== "") {
    parts.push(stringifyContent(message.content))
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    parts.push(`Tool calls: ${JSON.stringify(message.tool_calls)}`)
  }
  return truncateStart(parts.join("\n\n"), maxStringCharacters).value
}

function compactMessage(message, maxStringCharacters) {
  if (!message || typeof message !== "object") {
    return { role: "unknown", content: String(message) }
  }
  const compacted = {
    role: typeof message.role === "string" ? message.role : "unknown",
    content: messageText(message, maxStringCharacters),
  }
  if (typeof message.name === "string" && message.name) compacted.name = message.name
  if (typeof message.tool_call_id === "string" && message.tool_call_id) {
    compacted.tool_call_id = message.tool_call_id
  }
  return compacted
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function contextMetadata(state, details) {
  const serialized = JSON.stringify(state)
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    ...details,
  }
}

function shortenLongestMessage(state, maxBytes) {
  while (serializedBytes(state) > maxBytes) {
    const candidates = state.messages
      .map((message, index) => ({ index, length: message.content.length }))
      .filter(({ length }) => length > 64)
      .sort((a, b) => b.length - a.length)
    if (candidates.length === 0) break
    const message = state.messages[candidates[0].index]
    message.content = `${message.content.slice(0, Math.max(64, Math.floor(message.content.length / 2)))}\n[message truncated]`
  }
}

function realToolCalls(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return []
  return message.tool_calls.filter((call) => !isAutomatedAdvisorCallID(call?.id))
}

function completedExecutorModelCall(message) {
  if (message?.role !== "assistant") return false
  const hasContent = message.content !== undefined && message.content !== null && message.content !== ""
  return hasContent || realToolCalls(message).length > 0
}

function initialPrompt(messages, role) {
  const message = messages.find((candidate) => candidate?.role === role)
  return message ? stringifyContent(message.content) : null
}

function toolResultsByID(messages) {
  const results = new Map()
  for (const message of messages) {
    if (message?.role === "tool" && typeof message.tool_call_id === "string") {
      results.set(message.tool_call_id, stringifyContent(message.content))
    }
  }
  return results
}

function latestSuccessfulAdvice(messages, maxCharacters) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "tool" || !isAutomatedAdvisorCallID(message.tool_call_id)) continue
    if (!isSuccessfulAutomatedAdvisorResult(message.content)) continue
    const advice = message.content.slice(PLATFORM_ADVISOR_MESSAGE_PREFIX.length).trim()
    const compacted = truncateHeadTail(advice, maxCharacters, "latest advice")
    return {
      content: compacted.value,
      truncated: compacted.truncated,
      original_characters: compacted.original_characters,
    }
  }
  return null
}

function turnsSinceLatestAdvisorCall(messages) {
  let latestAdvisorCallIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => isAutomatedAdvisorCallID(call?.id))) {
      latestAdvisorCallIndex = index
      break
    }
  }
  if (latestAdvisorCallIndex === -1) return null
  return messages.slice(latestAdvisorCallIndex + 1).filter(completedExecutorModelCall).length
}

function classifierFeatures(messages, calls, featureConfig) {
  const toolResults = toolResultsByID(messages)
  const toolCounts = {}
  let latestCall = null
  let totalToolCalls = 0

  for (const message of messages) {
    for (const call of realToolCalls(message)) {
      const name = call?.function?.name || "unknown"
      toolCounts[name] = (toolCounts[name] || 0) + 1
      totalToolCalls += 1
      latestCall = call
    }
  }

  const distribution = Object.fromEntries(
    Object.entries(toolCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => [name, {
        count,
        fraction: totalToolCalls === 0 ? 0 : count / totalToolCalls,
      }]),
  )

  let latestToolCall = null
  if (latestCall) {
    const rawResult = toolResults.get(latestCall.id)
    const result = rawResult === undefined
      ? null
      : truncateHeadTail(rawResult, featureConfig.max_tool_result_characters, "tool result")
    latestToolCall = {
      name: latestCall?.function?.name || "unknown",
      arguments: latestCall?.function?.arguments ?? "",
      result: result?.value ?? null,
      result_truncated: result?.truncated ?? false,
      result_original_characters: result?.original_characters ?? null,
    }
  }

  return {
    tool_call_distribution: { total: totalToolCalls, by_name: distribution },
    turns_since_last_advisor_call: turnsSinceLatestAdvisorCall(messages),
    advisor_calls_total: calls,
    model_calls_total: messages.filter(completedExecutorModelCall).length,
    latest_tool_call: latestToolCall,
    latest_advice: latestSuccessfulAdvice(messages, featureConfig.max_latest_advice_characters),
  }
}

function addConfiguredFields(state, { turn, calls, maxCalls, stateConfig }) {
  if (stateConfig.frame) state.frame = stateConfig.frame
  if (stateConfig.include_turn) state.turn = turn
  if (stateConfig.include_advisor_calls_used) state.advisor_calls_used = calls
  if (stateConfig.include_advisor_calls_remaining) {
    if (maxCalls === null) {
      state.advisor_calls_remaining = null
      state.advisor_calls_unlimited = true
    } else {
      state.advisor_calls_remaining = Math.max(0, maxCalls - calls)
    }
  }
}

function addCompactedMessages(state, messages, contextConfig) {
  const originalMessageCount = messages.length
  state.messages = messages
  if (serializedBytes(state) <= contextConfig.max_bytes) {
    return { truncated: false, originalMessageCount }
  }

  const selected = []
  const preservedInitialCount = contextConfig.preserve_initial_task ? Math.min(2, messages.length) : 0
  if (preservedInitialCount > 0) selected.push(...messages.slice(0, preservedInitialCount))
  const firstRecentIndex = preservedInitialCount
  if (contextConfig.preserve_recent_messages) {
    let includedRecent = 0
    for (let index = messages.length - 1; index >= firstRecentIndex; index -= 1) {
      const candidate = [
        ...messages.slice(0, preservedInitialCount),
        messages[index],
        ...selected.slice(preservedInitialCount),
      ]
      const candidateState = { ...state, messages: candidate }
      if (serializedBytes(candidateState) <= contextConfig.max_bytes || includedRecent === 0) {
        selected.splice(preservedInitialCount, 0, messages[index])
        includedRecent += 1
      }
    }
  }
  state.messages = selected
  state.context_truncated = true
  state.original_message_count = originalMessageCount
  shortenLongestMessage(state, contextConfig.max_bytes)
  return { truncated: true, originalMessageCount }
}

export function buildClassifierState({ request, turn, calls, maxCalls, stateConfig }) {
  const contextConfig = stateConfig.context
  const originalMessages = Array.isArray(request.messages) ? request.messages : []
  const rewritten = rewriteAutomatedAdvisorMessages(originalMessages)
  const messages = (Array.isArray(rewritten) ? rewritten : [])
    .filter((message) => contextConfig.include_tool_results || message?.role !== "tool")
    .map((message) => compactMessage(message, contextConfig.max_string_characters))

  const state = {}
  addConfiguredFields(state, { turn, calls, maxCalls, stateConfig })

  if (stateConfig.input_mode !== "context") {
    state.initial_system_prompt = initialPrompt(originalMessages, "system")
    state.task_prompt = initialPrompt(originalMessages, "user")
    state.features = classifierFeatures(originalMessages, calls, stateConfig.features)
  }

  let contextDetails = { truncated: false, originalMessageCount: 0 }
  if (stateConfig.input_mode !== "features_only") {
    contextDetails = addCompactedMessages(state, messages, contextConfig)
  }

  if (serializedBytes(state) > contextConfig.max_bytes) {
    throw new Error(`OpenJev classifier state cannot fit max_bytes=${contextConfig.max_bytes}`)
  }
  const includedMessages = Array.isArray(state.messages) ? state.messages.length : 0
  return {
    state,
    metadata: contextMetadata(state, {
      input_mode: stateConfig.input_mode,
      truncated: contextDetails.truncated,
      original_messages: contextDetails.originalMessageCount,
      included_messages: includedMessages,
    }),
  }
}
