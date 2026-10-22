import assert from "node:assert/strict"
import test from "node:test"
import { buildClassifierState, compactClassifierStateForRetry } from "./classifier-context.mjs"
import {
  DEFAULT_OPENJEV_POLICY_CONFIG,
  OpenJevInterventionPolicy,
  parseAdvisorCallLimit,
  parseOpenJevPolicyConfig,
} from "./openjev-policy.mjs"
import { platformAdvisorMessage } from "./protocol.mjs"

function executorRequest(messages = [{ role: "user", content: "Fix the failing parser test." }]) {
  return { model: "executor", messages }
}

function response(choice = "continue_executor", inputTokens = 100) {
  return new Response(JSON.stringify({
    model: "openjev-FP8 test",
    usage: { input_tokens: inputTokens, output_tokens: 0 },
    answers: {
      advisor_decision: {
        type: "choice",
        choice,
        probabilities: { call_advisor: choice === "call_advisor" ? 0.8 : 0.2, continue_executor: choice === "continue_executor" ? 0.8 : 0.2 },
        confidence: 0.6,
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } })
}

test("uses the neutral concise advisor description as the default decision criterion", () => {
  const config = parseOpenJevPolicyConfig("")
  assert.match(config.request.question.instructions, /more likely than not to materially improve/)
  assert.match(config.request.question.criteria.call_advisor, /independent second opinion/)
  assert.equal(config.request.question.type, "choice")
})

test("accepts configurable framing, wording, labels, and token bounds", () => {
  const config = parseOpenJevPolicyConfig(JSON.stringify({
    schema_version: 2,
    request: {
      model: "custom-openjev",
      question_name: "consultation",
      question: {
        instructions: "Choose whether to consult.",
        criteria: { yes: "Consult now.", no: "Continue now." },
      },
    },
    state: {
      input_mode: "features_only",
      frame: "Custom frame",
      context: { max_input_tokens: 2048 },
    },
    decision: { call_choice: "yes", continue_choice: "no" },
  }))
  assert.equal(config.request.model, "custom-openjev")
  assert.equal(config.state.frame, "Custom frame")
  assert.equal(config.state.input_mode, "features_only")
  assert.equal(config.state.context.max_input_tokens, 2048)
  assert.equal(config.decision.call_choice, "yes")
  assert.deepEqual(Object.keys(config.request.question.criteria), ["yes", "no"])
})

test("migrates schema-1 byte and character limits to the exact token default", () => {
  const config = parseOpenJevPolicyConfig(JSON.stringify({
    schema_version: 1,
    state: {
      context: { max_bytes: 80000, max_string_characters: 64000 },
      features: {
        max_tool_result_characters: 12000,
        max_latest_advice_characters: 12000,
      },
    },
  }))
  assert.equal(config.schema_version, 2)
  assert.equal(config.state.context.max_input_tokens, 32767)
  assert.equal("max_bytes" in config.state.context, false)
  assert.equal("max_string_characters" in config.state.context, false)
  assert.deepEqual(config.state.features, {})
})

test("rejects removed byte and character fields in schema 2", () => {
  assert.throws(
    () => parseOpenJevPolicyConfig(JSON.stringify({
      schema_version: 2,
      state: { context: { max_bytes: 80000 } },
    })),
    /use state\.context\.max_input_tokens/,
  )
  assert.throws(
    () => parseOpenJevPolicyConfig(JSON.stringify({
      schema_version: 2,
      state: { features: { max_tool_result_characters: 12000 } },
    })),
    /feature character limits were removed/,
  )
})

test("supports omitted, explicit unlimited, or positive advisor-call limits", () => {
  assert.equal(parseAdvisorCallLimit(undefined), null)
  assert.equal(parseAdvisorCallLimit(""), null)
  assert.equal(parseAdvisorCallLimit("unlimited"), null)
  assert.equal(parseAdvisorCallLimit("5"), 5)
  assert.throws(() => parseAdvisorCallLimit("0"), /positive integer, 'unlimited', or omitted/)
})

test("queries OpenJev only on the configured eligible-turn interval", async () => {
  let requests = 0
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    interval: "3",
    fetchImpl: async () => {
      requests += 1
      return response("continue_executor")
    },
  })
  assert.equal((await policy.decide(executorRequest())).reason, "openjev-interval")
  assert.equal((await policy.decide(executorRequest())).reason, "openjev-interval")
  assert.equal((await policy.decide(executorRequest())).reason, "openjev-choice")
  assert.equal(requests, 1)
})

test("keeps the OpenJev classifier state separate from the selected advisor call", async () => {
  let classifierState
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    fetchImpl: async (_url, options) => {
      classifierState = JSON.parse(options.body).state
      return response("call_advisor")
    },
  })
  assert.equal((await policy.decide(executorRequest())).selected, true)
  assert.ok(classifierState)
  assert.equal("takeAdvisorContext" in policy, false)
})

test("sends compact state and selects an advisor without exposing the token", async () => {
  const calls = []
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "secret-token",
    maxCalls: "2",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return response("call_advisor")
    },
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, true)
  assert.equal(decision.calls, 1)
  assert.equal(calls[0].url, "http://openjev.invalid:3000/v1/systemone")
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-token")
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.model, "openjev")
  assert.equal(body.state.turn, 1)
  assert.equal(body.state.advisor_calls_remaining, 2)
  assert.deepEqual(body.state.messages, [{ role: "user", content: "Fix the failing parser test." }])
  assert.match(decision.classifier.sha256, /^[a-f0-9]{64}$/)
  assert.equal(decision.classifier.input_tokens, 100)
  assert.equal(decision.classifier.max_input_tokens, 32767)
})

test("unlimited mode keeps selecting with a mandatory executor turn after advice", async () => {
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000/v1",
    apiKey: "token",
    maxCalls: "unlimited",
    fetchImpl: async () => response("call_advisor"),
  })
  assert.equal((await policy.decide(executorRequest())).selected, true)
  assert.equal((await policy.decide(executorRequest())).reason, "post-advisor-executor-turn")
  assert.equal((await policy.decide(executorRequest())).selected, true)
  assert.equal(policy.calls, 2)
})

test("classifier errors fail open and do not consume an advisor call", async () => {
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    maxCalls: "3",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, false)
  assert.equal(decision.reason, "openjev-error")
  assert.equal(decision.classifier.error, "OpenJevHTTPError")
  assert.equal(decision.classifier.error_message, "OpenJev returned HTTP 401: unauthorized")
  assert.equal(decision.classifier.http_status, 401)
  assert.equal(policy.calls, 0)
})

test("rejects a successful helper response without exact input-token usage", async () => {
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    fetchImpl: async () => new Response(JSON.stringify({
      answers: { advisor_decision: { choice: "continue_executor" } },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, false)
  assert.equal(decision.reason, "openjev-error")
  assert.equal(decision.classifier.error, "OpenJevResponseError")
  assert.match(decision.classifier.error_message, /usage\.input_tokens/)
})

test("classifier transport errors retain their message and nested cause", async () => {
  const cause = new Error("getaddrinfo ENOTFOUND openjev-svc.wrong.svc.cluster.local")
  cause.name = "DNSError"
  const transportError = new TypeError("fetch failed", { cause })
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev-svc.wrong.svc.cluster.local:3000",
    apiKey: "token",
    maxCalls: "unlimited",
    transientRetries: 0,
    fetchImpl: async () => { throw transportError },
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, false)
  assert.equal(decision.reason, "openjev-error")
  assert.equal(decision.classifier.error, "TypeError")
  assert.equal(decision.classifier.error_message, "fetch failed")
  assert.equal(decision.classifier.error_cause, "DNSError")
  assert.match(decision.classifier.error_cause_message, /ENOTFOUND openjev-svc\.wrong/)
  assert.equal(policy.calls, 0)
})

test("retries transient classifier transport failures three times", async () => {
  let requests = 0
  const delays = []
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    transientRetries: 3,
    retryDelaySeconds: 30,
    sleepImpl: async (milliseconds) => { delays.push(milliseconds) },
    fetchImpl: async () => {
      requests += 1
      if (requests < 4) throw new TypeError("fetch failed")
      return response("continue_executor")
    },
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.reason, "openjev-choice")
  assert.equal(decision.classifier.transient_retries, 3)
  assert.equal(requests, 4)
  assert.deepEqual(delays, [30000, 30000, 30000])
})

test("retries transient classifier HTTP statuses but not permanent errors", async () => {
  let transientRequests = 0
  const transientPolicy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    transientRetries: 3,
    retryDelaySeconds: 30,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      transientRequests += 1
      return transientRequests < 3
        ? new Response("gateway timeout", { status: 504 })
        : response("continue_executor")
    },
  })
  const transientDecision = await transientPolicy.decide(executorRequest())
  assert.equal(transientDecision.classifier.transient_retries, 2)
  assert.equal(transientRequests, 3)

  let permanentRequests = 0
  const permanentPolicy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    transientRetries: 3,
    retryDelaySeconds: 0,
    fetchImpl: async () => {
      permanentRequests += 1
      return new Response("unauthorized", { status: 401 })
    },
  })
  const permanentDecision = await permanentPolicy.decide(executorRequest())
  assert.equal(permanentDecision.reason, "openjev-error")
  assert.equal(permanentRequests, 1)
})

test("classifier state preserves the complete initial prompt without byte or character truncation", () => {
  const stateConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG.state)
  const fullTask = `Initial task ${"constraint ".repeat(2000)}`
  const messages = [
    { role: "system", content: "Initial system prompt" },
    { role: "developer", content: "Bridge instructions" },
    { role: "user", content: fullTask },
    ...Array.from({ length: 10 }, (_, index) => ({ role: "tool", content: `${index}: ${"x".repeat(400)}` })),
    { role: "assistant", content: "Most recent reasoning" },
  ]
  const result = buildClassifierState({
    request: executorRequest(messages),
    turn: 4,
    calls: 1,
    maxCalls: 3,
    stateConfig,
  })
  assert.equal(result.metadata.truncated, false)
  assert.equal(result.state.messages[0].content, "Initial system prompt")
  assert.equal(result.state.messages[1].content, "Bridge instructions")
  assert.equal(result.state.messages[2].content, fullTask)
  assert.equal(result.state.messages.at(-1).content, "Most recent reasoning")
  assert.equal(result.metadata.protected_initial_messages, 3)
})

test("token-budget retry restores the cached task and bridge instructions", async () => {
  const requests = []
  const policyConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG)
  policyConfig.state.input_mode = "context"
  policyConfig.state.context.max_input_tokens = 1200
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    policyConfig: JSON.stringify(policyConfig),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).state)
      return response("continue_executor", requests.length === 2 ? 1800 : 900)
    },
  })
  const initialMessages = [
    { role: "system", content: "Generic executor system prompt" },
    { role: "developer", content: "Bridge instructions that must remain available" },
    { role: "user", content: "Original task that must remain available" },
  ]
  await policy.decide(executorRequest(initialMessages))

  const laterMessages = [
    { role: "system", content: "Generic executor system prompt" },
    { role: "system", content: platformAdvisorMessage("Prior advice") },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: "tool",
      content: `${index}: ${"x".repeat(500)}`,
    })),
    { role: "assistant", content: "Most recent executor reasoning" },
  ]
  const decision = await policy.decide(executorRequest(laterMessages))

  assert.equal(requests.length, 3)
  assert.equal(requests[2].context_truncated, true)
  assert.deepEqual(requests[2].messages.slice(0, 3), initialMessages)
  assert.equal(requests[2].messages.at(-1).content, "Most recent executor reasoning")
  assert.equal(decision.classifier.input_tokens, 900)
  assert.equal(decision.classifier.previous_input_tokens, 900)
  assert.equal(decision.classifier.compaction_attempts, 1)
  assert.equal(decision.classifier.truncated, true)
})

test("retries a helper-reported context overflow without removing protected messages", async () => {
  const requests = []
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).state)
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          error: { code: "context_length_exceeded", message: "maximum context length exceeded" },
        }), { status: 413, headers: { "content-type": "application/json" } })
      }
      return response("continue_executor", 1000)
    },
  })
  const messages = [
    { role: "system", content: "System" },
    { role: "user", content: "Task" },
    { role: "assistant", content: "Old reasoning" },
    { role: "tool", content: "Old result" },
    { role: "assistant", content: "Recent reasoning" },
  ]

  const decision = await policy.decide(executorRequest(messages))

  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].messages.slice(0, 2), messages.slice(0, 2))
  assert.equal(requests[1].messages.at(-1).content, "Recent reasoning")
  assert.equal(decision.classifier.compaction_attempts, 1)
})

test("retry compaction keeps assistant tool calls paired with their results", () => {
  const state = {
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Task" },
      { role: "assistant", content: "Old reasoning" },
      { role: "assistant", content: "Calling tool" },
      { role: "tool", tool_call_id: "call-1", content: "Tool result" },
      { role: "assistant", content: "Latest reasoning" },
    ],
  }
  const compacted = compactClassifierStateForRetry(state, 2)
  assert.deepEqual(compacted.messages.slice(0, 2), state.messages.slice(0, 2))
  assert.equal(compacted.messages.at(-1).content, "Latest reasoning")
  const toolResult = compacted.messages.findIndex((message) => message.role === "tool")
  assert.equal(toolResult === -1 || compacted.messages[toolResult - 1].role === "assistant", true)
})

test("retry never removes the final unprotected history unit", () => {
  const state = {
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Task" },
      { role: "assistant", content: "Only recent unit" },
    ],
  }
  const compacted = compactClassifierStateForRetry(state, 2)
  assert.equal(compacted, null)
})

test("retry removes at most five of the oldest history units", () => {
  const protectedMessages = [
    { role: "system", content: "System" },
    { role: "user", content: "Task" },
  ]
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: "assistant",
    content: `Unit ${index + 1}`,
  }))
  const compacted = compactClassifierStateForRetry({ messages: [...protectedMessages, ...history] }, 2)
  assert.deepEqual(compacted.messages.slice(0, 2), protectedMessages)
  assert.equal(compacted.messages.length, 17)
  assert.equal(compacted.messages[2].content, "Unit 6")
  assert.equal(compacted.messages.at(-1).content, "Unit 20")
})

test("a final overflowing history unit makes OpenJev unavailable and fails open", async () => {
  let requests = 0
  const policy = new OpenJevInterventionPolicy({
    baseURL: "http://openjev.invalid:3000",
    apiKey: "token",
    fetchImpl: async () => {
      requests += 1
      return new Response(JSON.stringify({
        error: { code: "context_length_exceeded", message: "maximum context length exceeded" },
      }), { status: 413, headers: { "content-type": "application/json" } })
    },
  })
  const decision = await policy.decide(executorRequest([
    { role: "system", content: "System" },
    { role: "user", content: "Task" },
    { role: "assistant", content: "Only recent unit" },
  ]))

  assert.equal(requests, 1)
  assert.equal(decision.selected, false)
  assert.equal(decision.reason, "openjev-error")
  assert.equal(decision.classifier.error, "OpenJevContextUnavailableError")
  assert.equal(decision.classifier.http_status, 413)
  assert.equal(policy.calls, 0)
})

test("feature-only state preserves prompts and exposes complete execution features", () => {
  const stateConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG.state)
  stateConfig.input_mode = "features_only"
  stateConfig.include_advisor_calls_remaining = false
  const exactArguments = JSON.stringify({ path: "src/parser.py", query: "a\\\"b" })
  const messages = [
    { role: "system", content: "Executor system instructions" },
    { role: "user", content: "Fix the parser regression" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_read_1", content: "file contents" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_platform_advisor_3_1", type: "function", function: { name: "advisory", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_platform_advisor_3_1", content: platformAdvisorMessage("Inspect the parser state before editing.") },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_bash_2", type: "function", function: { name: "bash", arguments: exactArguments } }],
    },
    { role: "tool", tool_call_id: "call_bash_2", content: `HEAD-${"x".repeat(300)}-TAIL` },
  ]
  const result = buildClassifierState({
    request: executorRequest(messages),
    turn: 5,
    calls: 1,
    maxCalls: null,
    stateConfig,
  })

  assert.equal(result.state.initial_system_prompt, "Executor system instructions")
  assert.equal(result.state.task_prompt, "Fix the parser regression")
  assert.equal(result.state.messages, undefined)
  assert.equal(result.state.advisor_calls_remaining, undefined)
  assert.deepEqual(result.state.features.tool_call_distribution, {
    total: 2,
    by_name: {
      bash: { count: 1, fraction: 0.5 },
      read: { count: 1, fraction: 0.5 },
    },
  })
  assert.equal(result.state.features.turns_since_last_advisor_call, 1)
  assert.equal(result.state.features.advisor_calls_total, 1)
  assert.equal(result.state.features.model_calls_total, 2)
  assert.equal(result.state.features.latest_tool_call.name, "bash")
  assert.equal(result.state.features.latest_tool_call.arguments, exactArguments)
  assert.equal(result.state.features.latest_tool_call.result_omitted_after_token_overflow, false)
  assert.match(result.state.features.latest_tool_call.result, /^HEAD-/)
  assert.match(result.state.features.latest_tool_call.result, /-TAIL$/)
  assert.equal(result.state.features.latest_advice.content, "Inspect the parser state before editing.")
  assert.equal(result.metadata.input_mode, "features_only")
})

test("feature-only retry omits whole optional values only after a token overflow", () => {
  const stateConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG.state)
  stateConfig.input_mode = "features_only"
  const result = buildClassifierState({
    request: executorRequest([
      { role: "system", content: "System" },
      { role: "user", content: "Task" },
      {
        role: "assistant",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-1", content: `HEAD-${"x".repeat(1000)}-TAIL` },
    ]),
    turn: 2,
    calls: 0,
    maxCalls: 3,
    stateConfig,
  })
  assert.equal(result.state.features.latest_tool_call.result_omitted_after_token_overflow, false)

  const compacted = compactClassifierStateForRetry(result.state, 0)
  assert.equal(compacted.features.latest_tool_call.result_omitted_after_token_overflow, true)
  assert.equal(compacted.features.latest_tool_call.result, null)
})

test("feature-plus-context state starts with complete context", () => {
  const stateConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG.state)
  stateConfig.input_mode = "features_plus_context"
  stateConfig.include_advisor_calls_remaining = false
  const messages = [
    { role: "system", content: "Executor system instructions" },
    { role: "user", content: "Initial task" },
    ...Array.from({ length: 10 }, (_, index) => ({ role: "tool", content: `${index}: ${"x".repeat(400)}` })),
    { role: "assistant", content: "Most recent reasoning" },
  ]
  const result = buildClassifierState({
    request: executorRequest(messages),
    turn: 4,
    calls: 0,
    maxCalls: null,
    stateConfig,
  })

  assert.equal(result.state.initial_system_prompt, "Executor system instructions")
  assert.equal(result.state.task_prompt, "Initial task")
  assert.equal(result.state.messages.at(-1).content, "Most recent reasoning")
  assert.equal(result.metadata.input_mode, "features_plus_context")
  assert.equal(result.metadata.truncated, false)
})

test("turns since advisor counts a failed initiated call even without advice", () => {
  const stateConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG.state)
  stateConfig.input_mode = "features_only"
  const messages = [
    { role: "system", content: "System" },
    { role: "user", content: "Task" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_platform_advisor_1_1", type: "function", function: { name: "advisory", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_platform_advisor_1_1", content: "The operation timed out." },
    { role: "assistant", content: "Continuing after the failed advisor call." },
  ]
  const result = buildClassifierState({
    request: executorRequest(messages),
    turn: 3,
    calls: 1,
    maxCalls: null,
    stateConfig,
  })
  assert.equal(result.state.features.turns_since_last_advisor_call, 1)
  assert.equal(result.state.features.latest_advice, null)
})
