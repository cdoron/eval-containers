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
function response(topLogprobs, model = "sii-decision-27b", promptTokens = 100) {
  return new Response(JSON.stringify({
    id: "cmpl-test",
    model,
    usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
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
        schema_version: 2,
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

test("migrates schema-1 byte and character limits to the model-specific token default", () => {
  const config = parseSiiDecisionPolicyConfig(JSON.stringify({
    schema_version: 1,
    state: {
      context: { max_bytes: 48000, max_string_characters: 12000 },
      features: {
        max_tool_result_characters: 12000,
        max_latest_advice_characters: 12000,
      },
    },
  }))
  assert.equal(config.schema_version, 2)
  assert.equal(config.state.context.max_input_tokens, 262143)
  assert.equal("max_bytes" in config.state.context, false)
  assert.equal("max_string_characters" in config.state.context, false)
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

test("defaults to a 0.5 call threshold: P(call_advisor) just above 0.5 selects", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    fetchImpl: async () => response({ A: -0.69, B: -0.72 }),
  })
  const decision = await policy.decide(executorRequest())
  assert.ok(decision.classifier.probabilities.call_advisor > 0.5)
  assert.equal(decision.selected, true)
})

test("a raised call threshold requires P(call_advisor) to clear it, not just exceed 0.5", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    callThreshold: 0.65,
    maxCalls: "1",
    fetchImpl: async () => response({ A: -0.5, B: -0.9 }), // P(call_advisor) ~= 0.60
  })
  const decision = await policy.decide(executorRequest())
  assert.ok(decision.classifier.probabilities.call_advisor > 0.5)
  assert.ok(decision.classifier.probabilities.call_advisor < 0.65)
  assert.equal(decision.selected, false)
  assert.equal(decision.classifier.choice, "continue_executor")
  assert.equal(policy.calls, 0)
})

test("a raised call threshold still selects once P(call_advisor) clears it", async () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    callThreshold: 0.65,
    maxCalls: "1",
    fetchImpl: async () => response({ A: -0.2, B: -1.0 }), // P(call_advisor) ~= 0.69
  })
  const decision = await policy.decide(executorRequest())
  assert.ok(decision.classifier.probabilities.call_advisor > 0.65)
  assert.equal(decision.selected, true)
  assert.equal(decision.classifier.choice, "call_advisor")
  assert.equal(policy.calls, 1)
})

test("rejects a call threshold outside (0, 1)", () => {
  for (const bad of [0, 1, -0.1, 1.1, NaN]) {
    assert.throws(
      () =>
        new SiiDecisionInterventionPolicy({
          baseURL: "http://sii-decision.invalid:8000",
          apiKey: "token",
          callThreshold: bad,
        }),
      /SII_DECISION_CALL_THRESHOLD must be a number strictly between 0 and 1/,
    )
  }
})

test("reports the configured call threshold in readyMetadata", () => {
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    callThreshold: 0.65,
  })
  assert.equal(policy.readyMetadata().call_threshold, 0.65)
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

test("keeps the SII decision state separate from the selected advisor call", async () => {
  let decisionPrompt
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    fetchImpl: async (_url, options) => {
      decisionPrompt = JSON.parse(options.body).prompt
      return response({ A: -0.01, B: -10.0 })
    },
  })
  assert.equal((await policy.decide(executorRequest())).selected, true)
  assert.match(decisionPrompt, /"turn":1/)
  assert.equal("takeAdvisorContext" in policy, false)
})

test("retries transient SII transport failures through the shared client", async () => {
  let requests = 0
  const delays = []
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    transientRetries: 2,
    retryDelaySeconds: 4,
    sleepImpl: async (milliseconds) => { delays.push(milliseconds) },
    fetchImpl: async () => {
      requests += 1
      if (requests < 3) throw new TypeError("fetch failed")
      return response({ A: -3.0, B: -0.1 })
    },
  })
  const decision = await policy.decide(executorRequest())
  assert.equal(decision.reason, "sii-decision-choice")
  assert.equal(decision.classifier.transient_retries, 2)
  assert.equal(requests, 3)
  assert.deepEqual(delays, [4000, 4000])
})

test("compacts SII context by complete history units after token overflow", async () => {
  const prompts = []
  const config = structuredClone(DEFAULT_SII_DECISION_POLICY_CONFIG)
  config.state.context.max_input_tokens = 1200
  const policy = new SiiDecisionInterventionPolicy({
    baseURL: "http://sii-decision.invalid:8000",
    apiKey: "token",
    policyConfig: JSON.stringify(config),
    fetchImpl: async (_url, options) => {
      prompts.push(JSON.parse(options.body).prompt)
      return response({ A: -3.0, B: -0.1 }, "sii-decision-27b", prompts.length === 1 ? 1800 : 900)
    },
  })
  const messages = [
    { role: "system", content: "System" },
    { role: "developer", content: "Bridge" },
    { role: "user", content: "Task" },
    { role: "assistant", content: "Old reasoning" },
    { role: "tool", content: "Old result" },
    { role: "assistant", content: "Recent reasoning" },
  ]
  const decision = await policy.decide(executorRequest(messages))
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /System/)
  assert.match(prompts[1], /Bridge/)
  assert.match(prompts[1], /Task/)
  assert.match(prompts[1], /Recent reasoning/)
  assert.doesNotMatch(prompts[1], /Old reasoning/)
  assert.equal(decision.classifier.input_tokens, 900)
  assert.equal(decision.classifier.compaction_attempts, 1)
  assert.equal(decision.classifier.truncated, true)
})
