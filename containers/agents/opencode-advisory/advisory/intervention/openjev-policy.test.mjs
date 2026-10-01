import assert from "node:assert/strict"
import test from "node:test"
import { buildClassifierState } from "./classifier-context.mjs"
import {
  DEFAULT_OPENJEV_POLICY_CONFIG,
  OpenJevInterventionPolicy,
  parseAdvisorCallLimit,
  parseOpenJevPolicyConfig,
} from "./openjev-policy.mjs"

function executorRequest(messages = [{ role: "user", content: "Fix the failing parser test." }]) {
  return { model: "executor", messages }
}

function response(choice = "continue_executor") {
  return new Response(JSON.stringify({
    model: "openjev-FP8 test",
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

test("accepts configurable framing, wording, labels, and context bounds", () => {
  const config = parseOpenJevPolicyConfig(JSON.stringify({
    schema_version: 1,
    request: {
      model: "custom-openjev",
      question_name: "consultation",
      question: {
        instructions: "Choose whether to consult.",
        criteria: { yes: "Consult now.", no: "Continue now." },
      },
    },
    state: { frame: "Custom frame", context: { max_bytes: 2048 } },
    decision: { call_choice: "yes", continue_choice: "no" },
  }))
  assert.equal(config.request.model, "custom-openjev")
  assert.equal(config.state.frame, "Custom frame")
  assert.equal(config.state.context.max_bytes, 2048)
  assert.equal(config.decision.call_choice, "yes")
  assert.deepEqual(Object.keys(config.request.question.criteria), ["yes", "no"])
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

test("retains the exact OpenJev state for the selected advisor call", async () => {
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
  assert.deepEqual(JSON.parse(policy.takeAdvisorContext()), classifierState)
  assert.equal(policy.takeAdvisorContext(), null)
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
  assert.equal(decision.classifier.http_status, 401)
  assert.equal(policy.calls, 0)
})

test("compact state preserves the task and recent context within the byte limit", () => {
  const stateConfig = structuredClone(DEFAULT_OPENJEV_POLICY_CONFIG.state)
  stateConfig.context.max_bytes = 1400
  stateConfig.context.max_string_characters = 500
  const messages = [
    { role: "user", content: "Initial task" },
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
  assert.equal(result.metadata.truncated, true)
  assert.equal(result.state.messages[0].content, "Initial task")
  assert.equal(result.state.messages.at(-1).content, "Most recent reasoning")
  assert.ok(result.metadata.bytes <= 1400)
})
