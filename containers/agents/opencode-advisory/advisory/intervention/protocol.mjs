"use strict"

export const AUTOMATED_ADVISOR_CALL_PREFIX = "call_platform_advisor_"
export const PLATFORM_ADVISOR_MESSAGE_PREFIX = [
  "This is not your tool call, but an advisor call initiated by the platform. The advisor's response is:",
  "",
  "Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence that the advice is wrong -- it is evidence that your test does not check what the advice is checking.",
  "",
  "If you have already retrieved data pointing one way and the advisor points another, do not silently switch. Surface the conflict in one more advisory call: \"I found X, you suggest Y; which constraint breaks the tie?\" The advisor saw your evidence but may have underweighted it; a reconciliation call is cheaper than committing to the wrong branch.",
].join("\n")

export function isAutomatedAdvisorCallID(callID) {
  return typeof callID === "string" && callID.startsWith(AUTOMATED_ADVISOR_CALL_PREFIX)
}

export function platformAdvisorMessage(advice) {
  const text = typeof advice === "string" ? advice : JSON.stringify(advice)
  if (text.startsWith(PLATFORM_ADVISOR_MESSAGE_PREFIX)) return text
  return `${PLATFORM_ADVISOR_MESSAGE_PREFIX}\n\n${text}`
}

export function isSuccessfulAutomatedAdvisorResult(content) {
  return typeof content === "string" &&
    content.startsWith(PLATFORM_ADVISOR_MESSAGE_PREFIX) &&
    content.slice(PLATFORM_ADVISOR_MESSAGE_PREFIX.length).trim().length > 0
}

function remainingAssistantMessage(message, automatedCallIDs) {
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((call) => {
        if (!isAutomatedAdvisorCallID(call?.id)) return true
        automatedCallIDs.add(call.id)
        return false
      })
    : undefined
  const contentPresent = message.content !== null && message.content !== undefined && message.content !== ""
  if (!contentPresent && (!toolCalls || toolCalls.length === 0)) return null
  return {
    ...message,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  }
}

export function rewriteAutomatedAdvisorMessages(messages) {
  if (!Array.isArray(messages)) return messages
  const automatedCallIDs = new Set()
  const rewritten = []

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      rewritten.push(message)
      continue
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const remaining = remainingAssistantMessage(message, automatedCallIDs)
      if (remaining) rewritten.push(remaining)
      continue
    }
    if (message.role === "tool" && automatedCallIDs.has(message.tool_call_id)) {
      if (isSuccessfulAutomatedAdvisorResult(message.content)) {
        rewritten.push({
          role: "system",
          content: message.content,
        })
      }
      continue
    }
    rewritten.push(message)
  }
  return rewritten
}
