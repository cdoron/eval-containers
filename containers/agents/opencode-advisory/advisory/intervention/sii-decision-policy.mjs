"use strict"

import crypto from "node:crypto"
import {
  buildClassifierState,
  captureInitialPromptMessages,
  classifierStateMetadata,
  compactClassifierStateForRetry,
} from "./classifier-context.mjs"
import {
  isContextOverflow,
  nonNegativeInteger,
  requestDecisionModel,
  responseError,
  sleep,
} from "./decision-model-client.mjs"
import { parseAdvisorCallLimit, parseOptionalPositiveInteger } from "./policy-config.mjs"

export { parseAdvisorCallLimit } from "./policy-config.mjs"

// jylin001206/SII-Decision-27B-Full has no published HTTP decision API (unlike
// OpenJev's own helper, systemOneURL below) — only an offline Transformers batch
// script. This policy ports that script's documented algorithm
// (github.com/amazingljy1206/SII-Decision, sii_decision/prompts.py + infer.py) onto
// the plain vLLM OpenAI-compatible server deployed in E-1/models/sii-decision-27b:
// render the model's own ChatML template with thinking disabled, append the
// "The correct answer is (" cue, take one forward pass, and read the LM-head
// logprobs for the two single-token option labels this policy always uses (A/B).
// This has only been sanity-checked against the live endpoint, not cross-validated
// against the upstream Transformers-based infer.py — see HANDOFF-experiments.md.
const CALL_LABEL = "A"
const CONTINUE_LABEL = "B"
const ANSWER_CUE = "The correct answer is ("

// This exact wrapper was captured 2026-10-15 from the live sii-decision-vllm
// endpoint's own /tokenize (messages=[{role:user,content:"..."}],
// add_generation_prompt=true, chat_template_kwargs={enable_thinking:false}),
// then confirmed to retokenize identically when sent back as a literal string via
// /v1/completions. It is this model's ChatML template, not a generic assumption —
// re-verify against chat_template.jinja (ships on the weights PVC) if the served
// checkpoint ever changes.
function chatWrap(body) {
  return `<|im_start|>user\n${body}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n${ANSWER_CUE}`
}

// Mirrors Python's json.dumps(..., sort_keys=True, ensure_ascii=False), which is
// what sii_decision/prompts.py's text() helper uses to render non-string state.
function sortedStringify(value) {
  if (Array.isArray(value)) return `[${value.map(sortedStringify).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export const DEFAULT_SII_DECISION_POLICY_CONFIG = Object.freeze({
  schema_version: 2,
  request: {
    model: "sii-decision-27b",
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
    input_mode: "context",
    frame: "You are deciding whether an autonomous software-engineering executor should consult an expert advisor before taking its next action.",
    include_turn: true,
    include_advisor_calls_used: true,
    include_advisor_calls_remaining: true,
    context: {
      max_input_tokens: 262143,
      preserve_initial_task: true,
      preserve_recent_messages: true,
      include_tool_results: true,
    },
    features: {},
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
    ...DEFAULT_SII_DECISION_POLICY_CONFIG,
    ...value,
    request: {
      ...DEFAULT_SII_DECISION_POLICY_CONFIG.request,
      ...(value.request || {}),
      question: {
        ...DEFAULT_SII_DECISION_POLICY_CONFIG.request.question,
        ...(value.request?.question || {}),
        criteria: value.request?.question?.criteria ?? DEFAULT_SII_DECISION_POLICY_CONFIG.request.question.criteria,
      },
    },
    state: {
      ...DEFAULT_SII_DECISION_POLICY_CONFIG.state,
      ...(value.state || {}),
      context: {
        ...DEFAULT_SII_DECISION_POLICY_CONFIG.state.context,
        ...(value.state?.context || {}),
      },
      features: {
        ...DEFAULT_SII_DECISION_POLICY_CONFIG.state.features,
        ...(value.state?.features || {}),
      },
    },
    decision: {
      ...DEFAULT_SII_DECISION_POLICY_CONFIG.decision,
      ...(value.decision || {}),
    },
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`)
}

function migrateLegacyConfig(value) {
  if (value.schema_version !== 1) return value
  const migrated = structuredClone(value)
  migrated.schema_version = 2
  if (plainObject(migrated.state?.context)) {
    delete migrated.state.context.max_bytes
    delete migrated.state.context.max_string_characters
  }
  if (plainObject(migrated.state?.features)) {
    delete migrated.state.features.max_tool_result_characters
    delete migrated.state.features.max_latest_advice_characters
  }
  return migrated
}

export function parseSiiDecisionPolicyConfig(raw = "") {
  let supplied = {}
  if (raw.trim()) {
    try {
      supplied = JSON.parse(raw)
    } catch (error) {
      throw new Error(`EVAL_ADVISOR_SII_DECISION_POLICY_CONFIG must be valid JSON: ${error.message}`)
    }
  }
  if (!plainObject(supplied)) throw new Error("EVAL_ADVISOR_SII_DECISION_POLICY_CONFIG must be a JSON object")
  supplied = migrateLegacyConfig(supplied)
  if (plainObject(supplied.state?.context) &&
      ("max_bytes" in supplied.state.context || "max_string_characters" in supplied.state.context)) {
    throw new Error("sii-decision byte/character context limits were removed; use state.context.max_input_tokens")
  }
  if (plainObject(supplied.state?.features) &&
      ("max_tool_result_characters" in supplied.state.features ||
       "max_latest_advice_characters" in supplied.state.features)) {
    throw new Error("sii-decision feature character limits were removed; max_input_tokens now governs the complete decision request")
  }
  const config = mergeConfig(supplied)
  if (config.schema_version !== 2) throw new Error("sii-decision policy schema_version must be 2")
  if (!plainObject(config.request) || !plainObject(config.request.question)) {
    throw new Error("sii-decision policy request.question must be an object")
  }
  requireString(config.request.model, "sii-decision request.model")
  requireString(config.request.question_name, "sii-decision request.question_name")
  if (config.request.question.type !== "choice") {
    throw new Error("sii-decision request.question.type must be 'choice'")
  }
  requireString(config.request.question.instructions, "sii-decision request.question.instructions")
  if (!plainObject(config.request.question.criteria) || Object.keys(config.request.question.criteria).length !== 2) {
    throw new Error("sii-decision request.question.criteria must contain exactly two choices (this policy only supports a binary call_advisor/continue_executor decision, labeled A/B)")
  }
  requireString(config.decision.call_choice, "sii-decision decision.call_choice")
  requireString(config.decision.continue_choice, "sii-decision decision.continue_choice")
  if (config.decision.call_choice === config.decision.continue_choice) {
    throw new Error("sii-decision call_choice and continue_choice must differ")
  }
  for (const choice of [config.decision.call_choice, config.decision.continue_choice]) {
    if (!(choice in config.request.question.criteria)) {
      throw new Error(`sii-decision decision choice '${choice}' is missing from request.question.criteria`)
    }
  }
  if (config.state.frame !== null && typeof config.state.frame !== "string") {
    throw new Error("sii-decision state.frame must be a string or null")
  }
  if (!["context", "features_only", "features_plus_context"].includes(config.state.input_mode)) {
    throw new Error("sii-decision state.input_mode must be context, features_only, or features_plus_context")
  }
  for (const key of [
    "include_turn",
    "include_advisor_calls_used",
    "include_advisor_calls_remaining",
  ]) {
    if (typeof config.state[key] !== "boolean") throw new Error(`sii-decision state.${key} must be boolean`)
  }
  for (const key of ["preserve_initial_task", "preserve_recent_messages", "include_tool_results"]) {
    if (typeof config.state.context[key] !== "boolean") {
      throw new Error(`sii-decision state.context.${key} must be boolean`)
    }
  }
  if (!Number.isSafeInteger(config.state.context.max_input_tokens) || config.state.context.max_input_tokens < 1024) {
    throw new Error("sii-decision state.context.max_input_tokens must be an integer of at least 1024")
  }
  return config
}

function completionsURL(baseURL) {
  const url = new URL(baseURL)
  const path = url.pathname.replace(/\/$/, "")
  if (path.endsWith("/v1/completions")) return url
  url.pathname = path.endsWith("/v1") ? `${path}/completions` : `${path}/v1/completions`
  return url
}

function renderedOptions(config) {
  return [
    { label: CALL_LABEL, key: config.decision.call_choice, desc: config.request.question.criteria[config.decision.call_choice] },
    { label: CONTINUE_LABEL, key: config.decision.continue_choice, desc: config.request.question.criteria[config.decision.continue_choice] },
  ]
}

function classifierError(error, latencyMs, contextMetadata) {
  const message = typeof error?.message === "string" ? error.message : ""
  const causeName = typeof error?.cause?.name === "string" ? error.cause.name : ""
  const causeMessage = typeof error?.cause?.message === "string" ? error.cause.message : ""
  return {
    selected: false,
    reason: "sii-decision-error",
    classifier: {
      error: error.name || "Error",
      ...(message ? { error_message: message } : {}),
      ...(causeName ? { error_cause: causeName } : {}),
      ...(causeMessage ? { error_cause_message: causeMessage } : {}),
      ...(Number.isSafeInteger(error.status) ? { http_status: error.status } : {}),
      ...(Number.isSafeInteger(error.transientRetries) ? { transient_retries: error.transientRetries } : {}),
      latency_ms: latencyMs,
      ...contextMetadata,
    },
  }
}

export class SiiDecisionInterventionPolicy {
  constructor({
    baseURL,
    apiKey,
    timeoutSeconds = 30,
    interval = 1,
    maxCalls,
    maxTurns = 0,
    policyConfig = "",
    logprobsCount = 20,
    transientRetries = process.env.EVAL_ADVISOR_TRANSIENT_RETRIES || 3,
    retryDelaySeconds = process.env.EVAL_ADVISOR_RETRY_DELAY_SECONDS || 30,
    fetchImpl = fetch,
    sleepImpl = sleep,
  }) {
    requireString(baseURL, "SII_DECISION_BASE_URL")
    requireString(apiKey, "SII_DECISION_API_KEY")
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) {
      throw new Error("EVAL_ADVISOR_SII_DECISION_TIMEOUT_SECONDS must be between 1 and 86400")
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0) {
      throw new Error("EVAL_EXECUTOR_MAX_TURNS must be a non-negative integer")
    }
    if (!Number.isSafeInteger(logprobsCount) || logprobsCount < 2 || logprobsCount > 256) {
      throw new Error("SII_DECISION_LOGPROBS must be an integer from 2 to 256")
    }
    this.name = "sii-decision"
    this.url = completionsURL(baseURL)
    this.apiKey = apiKey
    this.timeoutSeconds = timeoutSeconds
    this.interval = parseOptionalPositiveInteger(interval, "EVAL_ADVISOR_SII_DECISION_INTERVAL")
    if (this.interval === null) {
      throw new Error("EVAL_ADVISOR_SII_DECISION_INTERVAL must be a positive integer")
    }
    this.maxCalls = parseAdvisorCallLimit(maxCalls)
    this.maxTurns = maxTurns
    this.logprobsCount = logprobsCount
    this.transientRetries = nonNegativeInteger(transientRetries, "EVAL_ADVISOR_TRANSIENT_RETRIES")
    this.retryDelaySeconds = nonNegativeInteger(retryDelaySeconds, "EVAL_ADVISOR_RETRY_DELAY_SECONDS")
    this.config = parseSiiDecisionPolicyConfig(policyConfig)
    this.configSha256 = crypto.createHash("sha256").update(JSON.stringify(this.config)).digest("hex")
    this.fetchImpl = fetchImpl
    this.sleepImpl = sleepImpl
    this.eligibleTurns = 0
    this.calls = 0
    this.forceExecutorNext = false
    this.initialPromptMessages = null
    this.lastInputTokens = null
  }

  readyMetadata() {
    return {
      max_calls: this.maxCalls,
      max_calls_unlimited: this.maxCalls === null,
      max_turns: this.maxTurns,
      interval: this.interval,
      logprobs: this.logprobsCount,
      max_input_tokens: this.config.state.context.max_input_tokens,
      transient_retries: this.transientRetries,
      retry_delay_seconds: this.retryDelaySeconds,
      policy_config_sha256: this.configSha256,
    }
  }

  buildPrompt(state) {
    const options = renderedOptions(this.config)
    const choices = options.map((option) => `(${option.label}) ${option.key}: ${option.desc}`).join("\n")
    const body = `State:\n${sortedStringify(state)}\nQuestion: ${this.config.request.question.instructions}\nOptions:\n${choices}`.replace(/\s+$/, "")
    return chatWrap(body)
  }

  async requestClassifier(prompt) {
    return requestDecisionModel({
      url: this.url,
      apiKey: this.apiKey,
      payload: {
        model: this.config.request.model,
        prompt,
        max_tokens: 1,
        logprobs: this.logprobsCount,
        temperature: 0,
      },
      target: "sii-decision",
      timeoutSeconds: this.timeoutSeconds,
      transientRetries: this.transientRetries,
      retryDelaySeconds: this.retryDelaySeconds,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
    })
  }

  async decide(request) {
    if (this.initialPromptMessages === null) {
      this.initialPromptMessages = captureInitialPromptMessages(request?.messages)
    }
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
      return { selected: false, reason: "sii-decision-interval", turn, calls: this.calls }
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
        initialPromptMessages: this.initialPromptMessages,
      })
      let state = context.state
      let payload
      let inputTokens
      let compactionAttempts = 0
      let transientRetriesUsed = 0
      const previousInputTokens = this.lastInputTokens
      while (true) {
        const result = await this.requestClassifier(this.buildPrompt(state))
        const { response } = result
        payload = result.body
        transientRetriesUsed += result.transientRetries
        if (!response.ok) {
          const contextOverflow = isContextOverflow(response, payload)
          const compacted = contextOverflow
            ? compactClassifierStateForRetry(
                state,
                context.metadata.protected_initial_messages,
                this.config.state.context.preserve_recent_messages,
              )
            : null
          if (compacted) {
            state = compacted
            compactionAttempts += 1
            continue
          }
          const detail = responseError(payload).message
          const error = new Error(`sii-decision returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
          error.name = contextOverflow ? "SiiDecisionContextUnavailableError" : "SiiDecisionHTTPError"
          error.status = response.status
          error.transientRetries = transientRetriesUsed
          throw error
        }
        inputTokens = payload?.usage?.prompt_tokens
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
          const error = new Error("sii-decision response is missing usage.prompt_tokens")
          error.name = "SiiDecisionResponseError"
          throw error
        }
        if (inputTokens <= this.config.state.context.max_input_tokens) break
        const compacted = compactClassifierStateForRetry(
          state,
          context.metadata.protected_initial_messages,
          this.config.state.context.preserve_recent_messages,
        )
        if (!compacted) {
          const error = new Error(
            `sii-decision protected and most-recent context requires ${inputTokens} input tokens, exceeding max_input_tokens=${this.config.state.context.max_input_tokens}`,
          )
          error.name = "SiiDecisionTokenLimitError"
          throw error
        }
        state = compacted
        compactionAttempts += 1
      }
      const topLogprobs = payload?.choices?.[0]?.logprobs?.top_logprobs?.[0]
      const callLogprob = topLogprobs?.[CALL_LABEL]
      const continueLogprob = topLogprobs?.[CONTINUE_LABEL]
      if (typeof callLogprob !== "number" || typeof continueLogprob !== "number") {
        const error = new Error(
          `sii-decision response is missing a logprob for label '${CALL_LABEL}' or '${CONTINUE_LABEL}' within the requested top ${this.logprobsCount}; raise EVAL_ADVISOR_SII_DECISION_LOGPROBS (max 256) or inspect the raw response`,
        )
        error.name = "SiiDecisionResponseError"
        throw error
      }
      const callProb = Math.exp(callLogprob)
      const continueProb = Math.exp(continueLogprob)
      const total = callProb + continueProb
      const selected = callProb >= continueProb
      const choice = selected ? this.config.decision.call_choice : this.config.decision.continue_choice
      this.lastInputTokens = inputTokens
      if (selected) {
        this.calls += 1
        this.forceExecutorNext = true
      }
      return {
        selected,
        reason: "sii-decision-choice",
        turn,
        calls: this.calls,
        classifier: {
          choice,
          probabilities: {
            [this.config.decision.call_choice]: callProb / total,
            [this.config.decision.continue_choice]: continueProb / total,
          },
          confidence: Math.max(callProb, continueProb) / total,
          model: payload.model,
          input_tokens: inputTokens,
          max_input_tokens: this.config.state.context.max_input_tokens,
          previous_input_tokens: previousInputTokens,
          compaction_attempts: compactionAttempts,
          transient_retries: transientRetriesUsed,
          latency_ms: Date.now() - started,
          ...classifierStateMetadata(state, {
            ...context.metadata,
            truncated: compactionAttempts > 0,
            included_messages: Array.isArray(state.messages) ? state.messages.length : 0,
          }),
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
