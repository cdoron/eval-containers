"use strict"

import crypto from "node:crypto"
import { buildClassifierState } from "./classifier-context.mjs"
import { parseAdvisorCallLimit, parseOptionalPositiveInteger } from "./policy-config.mjs"

export { parseAdvisorCallLimit } from "./policy-config.mjs"

export const DEFAULT_OPENJEV_POLICY_CONFIG = Object.freeze({
  schema_version: 1,
  request: {
    model: "openjev",
    question_name: "advisor_decision",
    question: {
      type: "choice",
      instructions: "Decide whether consulting a separate, substantially larger and more capable language model is more likely than not to materially improve the result at this point in the task. Advisor calls are more expensive than continuing with the executor. When the state reports a finite remaining budget, those calls are limited and should be conserved.",
      criteria: {
        call_advisor: "The expected improvement from an independent second opinion justifies the higher cost and, when the budget is finite, spending one of the limited remaining advisor calls.",
        continue_executor: "The executor can continue effectively without paying the higher cost or spending a limited advisor call at this point.",
      },
    },
  },
  state: {
    frame: "You are deciding whether an autonomous software-engineering executor should consult an expert advisor before taking its next action.",
    include_turn: true,
    include_advisor_calls_used: true,
    include_advisor_calls_remaining: true,
    context: {
      max_bytes: 48000,
      max_string_characters: 12000,
      preserve_initial_task: true,
      preserve_recent_messages: true,
      include_tool_results: true,
    },
  },
  decision: {
    call_choice: "call_advisor",
    continue_choice: "continue_executor",
  },
})

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function mergeConfig(value) {
  return {
    ...DEFAULT_OPENJEV_POLICY_CONFIG,
    ...value,
    request: {
      ...DEFAULT_OPENJEV_POLICY_CONFIG.request,
      ...(value.request || {}),
      question: {
        ...DEFAULT_OPENJEV_POLICY_CONFIG.request.question,
        ...(value.request?.question || {}),
        criteria: value.request?.question?.criteria ?? DEFAULT_OPENJEV_POLICY_CONFIG.request.question.criteria,
      },
    },
    state: {
      ...DEFAULT_OPENJEV_POLICY_CONFIG.state,
      ...(value.state || {}),
      context: {
        ...DEFAULT_OPENJEV_POLICY_CONFIG.state.context,
        ...(value.state?.context || {}),
      },
    },
    decision: {
      ...DEFAULT_OPENJEV_POLICY_CONFIG.decision,
      ...(value.decision || {}),
    },
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`)
}

export function parseOpenJevPolicyConfig(raw = "") {
  let supplied = {}
  if (raw.trim()) {
    try {
      supplied = JSON.parse(raw)
    } catch (error) {
      throw new Error(`EVAL_ADVISOR_OPENJEV_POLICY_CONFIG must be valid JSON: ${error.message}`)
    }
  }
  if (!plainObject(supplied)) throw new Error("EVAL_ADVISOR_OPENJEV_POLICY_CONFIG must be a JSON object")
  const config = mergeConfig(supplied)
  if (config.schema_version !== 1) throw new Error("OpenJev policy schema_version must be 1")
  if (!plainObject(config.request) || !plainObject(config.request.question)) {
    throw new Error("OpenJev policy request.question must be an object")
  }
  requireString(config.request.model, "OpenJev request.model")
  requireString(config.request.question_name, "OpenJev request.question_name")
  if (config.request.question.type !== "choice") {
    throw new Error("OpenJev request.question.type must be 'choice'")
  }
  requireString(config.request.question.instructions, "OpenJev request.question.instructions")
  if (!plainObject(config.request.question.criteria) || Object.keys(config.request.question.criteria).length < 2) {
    throw new Error("OpenJev request.question.criteria must contain at least two choices")
  }
  requireString(config.decision.call_choice, "OpenJev decision.call_choice")
  requireString(config.decision.continue_choice, "OpenJev decision.continue_choice")
  if (config.decision.call_choice === config.decision.continue_choice) {
    throw new Error("OpenJev call_choice and continue_choice must differ")
  }
  for (const choice of [config.decision.call_choice, config.decision.continue_choice]) {
    if (!(choice in config.request.question.criteria)) {
      throw new Error(`OpenJev decision choice '${choice}' is missing from request.question.criteria`)
    }
  }
  if (config.state.frame !== null && typeof config.state.frame !== "string") {
    throw new Error("OpenJev state.frame must be a string or null")
  }
  for (const key of [
    "include_turn",
    "include_advisor_calls_used",
    "include_advisor_calls_remaining",
  ]) {
    if (typeof config.state[key] !== "boolean") throw new Error(`OpenJev state.${key} must be boolean`)
  }
  for (const key of ["preserve_initial_task", "preserve_recent_messages", "include_tool_results"]) {
    if (typeof config.state.context[key] !== "boolean") {
      throw new Error(`OpenJev state.context.${key} must be boolean`)
    }
  }
  if (!Number.isSafeInteger(config.state.context.max_bytes) || config.state.context.max_bytes < 1024) {
    throw new Error("OpenJev state.context.max_bytes must be an integer of at least 1024")
  }
  if (!Number.isSafeInteger(config.state.context.max_string_characters) || config.state.context.max_string_characters < 64) {
    throw new Error("OpenJev state.context.max_string_characters must be an integer of at least 64")
  }
  return config
}

function systemOneURL(baseURL) {
  const url = new URL(baseURL)
  const path = url.pathname.replace(/\/$/, "")
  if (path.endsWith("/v1/systemone")) return url
  url.pathname = path.endsWith("/v1") ? `${path}/systemone` : `${path}/v1/systemone`
  return url
}

function classifierError(error, latencyMs, contextMetadata) {
  return {
    selected: false,
    reason: "openjev-error",
    classifier: {
      error: error.name || "Error",
      ...(Number.isSafeInteger(error.status) ? { http_status: error.status } : {}),
      latency_ms: latencyMs,
      ...contextMetadata,
    },
  }
}

export class OpenJevInterventionPolicy {
  constructor({ baseURL, apiKey, timeoutSeconds = 30, interval = 1, maxCalls, maxTurns = 0, policyConfig = "", fetchImpl = fetch }) {
    requireString(baseURL, "OPENJEV_BASE_URL")
    requireString(apiKey, "OPENJEV_API_KEY")
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) {
      throw new Error("EVAL_ADVISOR_OPENJEV_TIMEOUT_SECONDS must be between 1 and 86400")
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0) {
      throw new Error("EVAL_EXECUTOR_MAX_TURNS must be a non-negative integer")
    }
    this.name = "openjev"
    this.url = systemOneURL(baseURL)
    this.apiKey = apiKey
    this.timeoutSeconds = timeoutSeconds
    this.interval = parseOptionalPositiveInteger(interval, "EVAL_ADVISOR_OPENJEV_INTERVAL")
    if (this.interval === null) {
      throw new Error("EVAL_ADVISOR_OPENJEV_INTERVAL must be a positive integer")
    }
    this.maxCalls = parseAdvisorCallLimit(maxCalls)
    this.maxTurns = maxTurns
    this.config = parseOpenJevPolicyConfig(policyConfig)
    this.configSha256 = crypto.createHash("sha256").update(JSON.stringify(this.config)).digest("hex")
    this.fetchImpl = fetchImpl
    this.eligibleTurns = 0
    this.calls = 0
    this.forceExecutorNext = false
    this.pendingAdvisorContext = null
  }

  readyMetadata() {
    return {
      max_calls: this.maxCalls,
      max_calls_unlimited: this.maxCalls === null,
      max_turns: this.maxTurns,
      interval: this.interval,
      policy_config_sha256: this.configSha256,
    }
  }

  takeAdvisorContext() {
    const context = this.pendingAdvisorContext
    this.pendingAdvisorContext = null
    return context
  }

  async decide(request) {
    this.eligibleTurns += 1
    const turn = this.eligibleTurns
    if (this.maxTurns > 0 && turn > this.maxTurns) {
      return { selected: false, terminate: true, reason: "turn-cap-reached", turn, calls: this.calls }
    }
    if (this.forceExecutorNext) {
      this.forceExecutorNext = false
      return { selected: false, reason: "post-advisor-executor-turn", turn, calls: this.calls }
    }
    if (this.maxCalls !== null && this.calls >= this.maxCalls) {
      return { selected: false, reason: "call-cap-reached", turn, calls: this.calls }
    }
    if (turn % this.interval !== 0) {
      return { selected: false, reason: "openjev-interval", turn, calls: this.calls }
    }

    let context
    const started = Date.now()
    try {
      context = buildClassifierState({
        request,
        turn,
        calls: this.calls,
        maxCalls: this.maxCalls,
        stateConfig: this.config.state,
      })
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.request.model,
          state: context.state,
          questions: {
            [this.config.request.question_name]: this.config.request.question,
          },
        }),
      })
      if (!response.ok) {
        const error = new Error(`OpenJev returned HTTP ${response.status}`)
        error.name = "OpenJevHTTPError"
        error.status = response.status
        throw error
      }
      const body = await response.json()
      const answer = body?.answers?.[this.config.request.question_name]
      const choice = answer?.choice
      if (choice !== this.config.decision.call_choice && choice !== this.config.decision.continue_choice) {
        const error = new Error("OpenJev returned an unknown or missing choice")
        error.name = "OpenJevResponseError"
        throw error
      }
      const selected = choice === this.config.decision.call_choice
      if (selected) {
        this.pendingAdvisorContext = JSON.stringify(context.state)
        this.calls += 1
        this.forceExecutorNext = true
      }
      return {
        selected,
        reason: "openjev-choice",
        turn,
        calls: this.calls,
        classifier: {
          choice,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
          model: body.model,
          latency_ms: Date.now() - started,
          ...context.metadata,
        },
      }
    } catch (error) {
      return {
        ...classifierError(error, Date.now() - started, context?.metadata || {}),
        turn,
        calls: this.calls,
      }
    }
  }
}
