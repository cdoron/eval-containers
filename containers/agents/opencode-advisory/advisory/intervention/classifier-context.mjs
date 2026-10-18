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

function messageText(message) {
  const parts = []
  if (message.content !== undefined && message.content !== null && message.content !== "") {
    parts.push(stringifyContent(message.content))
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    parts.push(`Tool calls: ${JSON.stringify(message.tool_calls)}`)
  }
  return parts.join("\n\n")
}

function compactMessage(message) {
  if (!message || typeof message !== "object") {
    return { role: "unknown", content: String(message) }
  }
  const compacted = {
    role: typeof message.role === "string" ? message.role : "unknown",
    content: messageText(message),
  }
  if (typeof message.name === "string" && message.name) compacted.name = message.name
  if (typeof message.tool_call_id === "string" && message.tool_call_id) {
    compacted.tool_call_id = message.tool_call_id
  }
  return compacted
}

export function classifierStateMetadata(state, details = {}) {
  const serialized = JSON.stringify(state)
  return {
    ...details,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
  }
}

export function captureInitialPromptMessages(messages) {
  if (!Array.isArray(messages)) return []
  const initial = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    if (message.role === "assistant" || message.role === "tool") break
    if (message.role === "system" || message.role === "developer" || message.role === "user") {
      initial.push(message)
    }
  }
  return initial
}

function prependProtectedInitialMessages(messages, protectedInitialMessages) {
  const remaining = [...messages]
  for (const protectedMessage of protectedInitialMessages) {
    const signature = JSON.stringify(protectedMessage)
    const index = remaining.findIndex((message) => JSON.stringify(message) === signature)
    if (index >= 0) remaining.splice(index, 1)
  }
  return [...protectedInitialMessages, ...remaining]
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

function latestSuccessfulAdvice(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "tool" || !isAutomatedAdvisorCallID(message.tool_call_id)) continue
    if (!isSuccessfulAutomatedAdvisorResult(message.content)) continue
    const advice = message.content.slice(PLATFORM_ADVISOR_MESSAGE_PREFIX.length).trim()
    return {
      content: advice,
      omitted_after_token_overflow: false,
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

function classifierFeatures(messages, calls) {
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
    latestToolCall = {
      name: latestCall?.function?.name || "unknown",
      arguments: latestCall?.function?.arguments ?? "",
      result: rawResult ?? null,
      result_omitted_after_token_overflow: false,
    }
  }

  return {
    tool_call_distribution: { total: totalToolCalls, by_name: distribution },
    turns_since_last_advisor_call: turnsSinceLatestAdvisorCall(messages),
    advisor_calls_total: calls,
    model_calls_total: messages.filter(completedExecutorModelCall).length,
    latest_tool_call: latestToolCall,
    latest_advice: latestSuccessfulAdvice(messages),
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

function addClassifierMessages(state, messages, contextConfig, protectedInitialMessages) {
  const protectedInitialCount = contextConfig.preserve_initial_task
    ? protectedInitialMessages.length
    : 0
  state.messages = contextConfig.preserve_initial_task
    ? prependProtectedInitialMessages(messages, protectedInitialMessages)
    : messages
  return { originalMessageCount: state.messages.length, protectedInitialCount }
}

function historyUnits(messages) {
  const units = []
  for (const message of messages) {
    const previous = units.at(-1)
    if (message?.role === "tool" && previous?.[0]?.role === "assistant") {
      previous.push(message)
    } else {
      units.push([message])
    }
  }
  return units
}

function omitRetryableFeature(state) {
  const compacted = structuredClone(state)
  if (typeof compacted.features?.latest_advice?.content === "string") {
    compacted.features.latest_advice.content = null
    compacted.features.latest_advice.omitted_after_token_overflow = true
  } else if (typeof compacted.features?.latest_tool_call?.result === "string") {
    compacted.features.latest_tool_call.result = null
    compacted.features.latest_tool_call.result_omitted_after_token_overflow = true
  } else {
    return null
  }
  compacted.context_truncated = true
  return compacted
}

export function compactClassifierStateForRetry(state, protectedInitialCount, preserveRecentMessages = true) {
  if (!Array.isArray(state.messages)) return omitRetryableFeature(state)
  const protectedMessages = state.messages.slice(0, protectedInitialCount)
  if (!preserveRecentMessages) {
    if (state.messages.length !== protectedMessages.length) {
      return {
        ...state,
        messages: protectedMessages,
        context_truncated: true,
        original_message_count: state.original_message_count ?? state.messages.length,
      }
    }
    return omitRetryableFeature(state)
  }
  const units = historyUnits(state.messages.slice(protectedInitialCount))
  if (units.length <= 1) {
    const compactedFeatures = omitRetryableFeature(state)
    if (compactedFeatures) return compactedFeatures
    return null
  }

  const removeCount = Math.max(1, Math.min(5, Math.floor(units.length / 2)))
  const retained = units.slice(removeCount).flat()
  return {
    ...state,
    messages: [...protectedMessages, ...retained],
    context_truncated: true,
    original_message_count: state.original_message_count ?? state.messages.length,
  }
}

export function buildClassifierState({ request, turn, calls, maxCalls, stateConfig, initialPromptMessages }) {
  const contextConfig = stateConfig.context
  const originalMessages = Array.isArray(request.messages) ? request.messages : []
  const initialMessages = Array.isArray(initialPromptMessages) && initialPromptMessages.length > 0
    ? initialPromptMessages
    : captureInitialPromptMessages(originalMessages)
  const protectedInitialMessages = initialMessages.map(compactMessage)
  const rewritten = rewriteAutomatedAdvisorMessages(originalMessages)
  const messages = (Array.isArray(rewritten) ? rewritten : [])
    .filter((message) => contextConfig.include_tool_results || message?.role !== "tool")
    .map(compactMessage)

  const state = {}
  addConfiguredFields(state, { turn, calls, maxCalls, stateConfig })

  if (stateConfig.input_mode !== "context") {
    state.initial_system_prompt = initialPrompt(initialMessages, "system")
    state.task_prompt = initialPrompt(initialMessages, "user")
    state.features = classifierFeatures(originalMessages, calls)
  }

  let contextDetails = { originalMessageCount: 0, protectedInitialCount: 0 }
  if (stateConfig.input_mode !== "features_only") {
    contextDetails = addClassifierMessages(
      state,
      messages,
      contextConfig,
      protectedInitialMessages,
    )
  }

  const includedMessages = Array.isArray(state.messages) ? state.messages.length : 0
  return {
    state,
    metadata: classifierStateMetadata(state, {
      input_mode: stateConfig.input_mode,
      truncated: false,
      original_messages: contextDetails.originalMessageCount,
      included_messages: includedMessages,
      protected_initial_messages: contextDetails.protectedInitialCount,
    }),
  }
}
