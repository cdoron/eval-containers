"use strict"

import crypto from "node:crypto"
import { rewriteAutomatedAdvisorMessages } from "./protocol.mjs"

function messageText(message, maxStringCharacters) {
  const parts = []
  if (message.content !== undefined && message.content !== null && message.content !== "") {
    parts.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    parts.push(`Tool calls: ${JSON.stringify(message.tool_calls)}`)
  }
  const content = parts.join("\n\n")
  if (content.length <= maxStringCharacters) return content
  return `${content.slice(0, maxStringCharacters)}\n[message truncated]`
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

export function buildClassifierState({ request, turn, calls, maxCalls, stateConfig }) {
  const contextConfig = stateConfig.context
  const rewritten = rewriteAutomatedAdvisorMessages(request.messages)
  const messages = (Array.isArray(rewritten) ? rewritten : [])
    .filter((message) => contextConfig.include_tool_results || message?.role !== "tool")
    .map((message) => compactMessage(message, contextConfig.max_string_characters))

  const state = {}
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

  state.messages = messages
  const originalMessageCount = messages.length
  if (serializedBytes(state) <= contextConfig.max_bytes) {
    return {
      state,
      metadata: contextMetadata(state, {
        truncated: false,
        original_messages: originalMessageCount,
        included_messages: originalMessageCount,
      }),
    }
  }

  const selected = []
  if (contextConfig.preserve_initial_task && messages.length > 0) selected.push(messages[0])
  const firstRecentIndex = contextConfig.preserve_initial_task ? 1 : 0
  if (contextConfig.preserve_recent_messages) {
    let includedRecent = 0
    for (let index = messages.length - 1; index >= firstRecentIndex; index -= 1) {
      const candidate = [
        ...(contextConfig.preserve_initial_task && messages.length > 0 ? [messages[0]] : []),
        messages[index],
        ...selected.slice(contextConfig.preserve_initial_task ? 1 : 0),
      ]
      const candidateState = { ...state, messages: candidate }
      if (serializedBytes(candidateState) <= contextConfig.max_bytes || includedRecent === 0) {
        selected.splice(contextConfig.preserve_initial_task ? 1 : 0, 0, messages[index])
        includedRecent += 1
      }
    }
  }
  state.messages = selected
  state.context_truncated = true
  state.original_message_count = originalMessageCount
  shortenLongestMessage(state, contextConfig.max_bytes)

  if (serializedBytes(state) > contextConfig.max_bytes) {
    throw new Error(`OpenJev classifier state cannot fit max_bytes=${contextConfig.max_bytes}`)
  }
  return {
    state,
    metadata: contextMetadata(state, {
      truncated: true,
      original_messages: originalMessageCount,
      included_messages: state.messages.length,
    }),
  }
}
