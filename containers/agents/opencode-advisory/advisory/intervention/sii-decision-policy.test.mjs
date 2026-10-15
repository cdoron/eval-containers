import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_SII_DECISION_POLICY_CONFIG,
  parseAdvisorCallLimit,
  parseSiiDecisionPolicyConfig,
  SiiDecisionInterventionPolicy,
} from "./sii-decision-policy.mjs"

function executorRequest(messages = [{ role: "user", content: "Fix the failing parser test." }]) {
  return { model: "executor", messages }
}

// Shaped like a real vLLM /v1/completions response with logprobs=N (confirmed
// live against sii-decision-vllm.advisor-erel on 2026-10-15).
function response(topLogprobs, model = "sii-decision-27b") {
  return new Response(JSON.stringify({
    id: "cmpl-test",
    model,
    choices: [
      {
        index: 0,
        text: Object.entries(topLogprobs).sort((a, b) => b[1] - a[1])[0][0],
        logprobs: { top_logprobs: [topLogprobs] },
        finish_reason: "length",
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } })
}

test("uses the neutral concise advisor description as the default decision criterion", () => {
  const config = parseSiiDecisionPolicyConfig("")
  assert.match(config.request.question.instructions, /more likely than not to materially improve/)
  assert.match(config.request.question.criteria.call_advisor, /independent second opinion/)
  assert.equal(config.request.question.type, "choice")
})

test("requires exactly two criteria", () => {
  assert.throws(
    () =>
      parseSiiDecisionPolicyConfig(JSON.stringify({
        schema_version: 1,
        request: {
          model: "sii-decision-27b",
          question_name: "advisor_decision",
          question: {
            type: "choice",
            instructions: "Choose.",
            criteria: { a: "A", b: "B", c: "C" },
          },
        },
        decision: { call_choice: "a", continue_choice: "b" },
      })),
    /exactly two choices/,
  )
})

test("supports omitted, explicit unlimited, or positive advisor-call limits", () => {
  assert.equal(parseAdvisorCallLimit(undefined), null)
  assert.equal(parseAdvisorCallLimit("unlimited"), null)
  assert.equal(parseAdvisorCallLimit("5"), 5)
})

test("builds a prompt ending in the ChatML wrapper and answer cue, options labeled A/B in call/continue order", async () => {
  let sentPrompt
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    fetchImpl: async (_url, options) => {
      sentPrompt = JSON.parse(options.body).prompt
      return response({ A: -0.1, B: -3.0 })
    },
  })
  await policy.decide(executorRequest())
  assert.match(sentPrompt, /^<\|im_start\|>user\n/)
  assert.match(sentPrompt, /<\|im_start\|>assistant\n<think>\n\n<\/think>\n\nThe correct answer is \($/)
  assert.match(sentPrompt, /\(A\) call_advisor: .*independent second opinion/)
  assert.match(sentPrompt, /\(B\) continue_executor: .*without paying the higher cost/)
})

test("requests logprobs, max_tokens=1, and the configured model name", async () => {
  const calls = []
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "secret-token",
    logprobsCount: 32,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return response({ A: -0.1, B: -3.0 })
    },
  })
  await policy.decide(executorRequest())
  assert.equal(calls[0].url, "http://sii-decision.invalid:8000/v1/completions")
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-token")
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.model, DEFAULT_SII_DECISION_POLICY_CONFIG.request.model)
  assert.equal(body.max_tokens, 1)
  assert.equal(body.logprobs, 32)
})

test("normalizes logprobs over just the two option tokens (equal logprobs => 0.5/0.5)", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    fetchImpl: async () => response({ A: -1.0, B: -1.0 }),
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.classifier.probabilities.call_advisor, 0.5)
  assert.equal(decision.classifier.probabilities.continue_executor, 0.5)
})

test("a much larger A logprob selects call_advisor with probability close to 1", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    maxCalls: "1",
    fetchImpl: async () => response({ A: -0.01, B: -10.0 }),
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, true)
  assert.equal(decision.reason, "sii-decision-choice")
  assert.equal(decision.classifier.choice, "call_advisor")
  assert.ok(decision.classifier.probabilities.call_advisor > 0.99)
  assert.equal(decision.calls, 1)
})

test("errors clearly, failing open, when a required label is missing from the returned top_logprobs", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    maxCalls: "3",
    fetchImpl: async () => response({ C: -0.1, D: -3.0 }),
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, false)
  assert.equal(decision.reason, "sii-decision-error")
  assert.equal(decision.classifier.error, "SiiDecisionResponseError")
  assert.match(decision.classifier.error_message, /missing a logprob for label 'A' or 'B'/)
  assert.equal(policy.calls, 0)
})

test("HTTP errors fail open and do not consume an advisor call", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    maxCalls: "3",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.selected, false)
  assert.equal(decision.reason, "sii-decision-error")
  assert.equal(decision.classifier.error, "SiiDecisionHTTPError")
  assert.equal(decision.classifier.http_status, 401)
  assert.equal(policy.calls, 0)
})

test("queries sii-decision only on the configured eligible-turn interval", async () => {
  let requests = 0
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    interval: "3",
    fetchImpl: async () => {
      requests += 1
      return response({ A: -3.0, B: -0.1 })
    },
  })
  assert.equal((await policy.decide(executorRequest())).reason, "sii-decision-interval")
  assert.equal((await policy.decide(executorRequest())).reason, "sii-decision-interval")
  assert.equal((await policy.decide(executorRequest())).reason, "sii-decision-choice")
  assert.equal(requests, 1)
})

test("unlimited mode keeps selecting with a mandatory executor turn after advice", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    maxCalls: "unlimited",
    fetchImpl: async () => response({ A: -0.01, B: -10.0 }),
  })
  assert.equal((await policy.decide(executorRequest())).selected, true)
  assert.equal((await policy.decide(executorRequest())).reason, "post-advisor-executor-turn")
  assert.equal((await policy.decide(executorRequest())).selected, true)
  assert.equal(policy.calls, 2)
})

test("retains the exact state for the selected advisor call", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    fetchImpl: async () => response({ A: -0.01, B: -10.0 }),
  })
  assert.equal((await policy.decide(executorRequest())).selected, true)
  const context = JSON.parse(policy.takeAdvisorContext())
  assert.equal(context.turn, 1)
  assert.equal(policy.takeAdvisorContext(), null)
})
