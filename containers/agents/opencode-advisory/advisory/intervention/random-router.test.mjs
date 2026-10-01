import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import {
  RandomInterventionPolicy,
  createRouter,
  deterministicDraw,
  isEligibleExecutorTurn,
  stripAdvisoryTool,
  syntheticResponse,
  terminalResponse,
} from "./random-router.mjs"
import {
  PLATFORM_ADVISOR_MESSAGE_PREFIX,
  platformAdvisorMessage,
  rewriteAutomatedAdvisorMessages,
} from "./protocol.mjs"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function request(overrides = {}) {
  return {
    model: "executor",
    messages: [{ role: "user", content: "Fix the bug" }],
    tools: [
      { type: "function", function: { name: "bash", parameters: {} } },
      { type: "function", function: { name: "advisory", parameters: {} } },
    ],
    ...overrides,
  }
}

test("recognizes only main executor turns and hides advisory from the executor", () => {
  assert.equal(isEligibleExecutorTurn(request()), true)
  assert.equal(isEligibleExecutorTurn({ model: "small", messages: [] }), false)
  const stripped = stripAdvisoryTool(request({
    tool_choice: { type: "function", function: { name: "advisory" } },
  }))
  assert.deepEqual(stripped.tools.map((tool) => tool.function.name), ["bash"])
  assert.equal(stripped.tool_choice, "auto")
})

test("uses deterministic draws and enforces the cap with an executor turn after advice", () => {
  assert.equal(deterministicDraw("seed", 3), deterministicDraw("seed", 3))
  const policy = new RandomInterventionPolicy({ probability: 1, maxCalls: 2, seed: "seed" })
  assert.equal(policy.decide().selected, true)
  assert.equal(policy.decide().reason, "post-advisor-executor-turn")
  assert.equal(policy.decide().selected, true)
  assert.equal(policy.decide().reason, "post-advisor-executor-turn")
  assert.equal(policy.decide().reason, "call-cap-reached")
})

test("allows an omitted or explicit unlimited random advisor-call cap", () => {
  for (const maxCalls of [undefined, "", "unlimited"]) {
    const policy = new RandomInterventionPolicy({ probability: 1, maxCalls, seed: "seed" })
    assert.equal(policy.readyMetadata().max_calls_unlimited, true)
    assert.equal(policy.decide().selected, true)
    assert.equal(policy.decide().reason, "post-advisor-executor-turn")
    assert.equal(policy.decide().selected, true)
  }
})

test("terminates after the configured executor turn cap", () => {
  const policy = new RandomInterventionPolicy({
    probability: 0,
    maxCalls: 1,
    maxTurns: 2,
    seed: "seed",
  })
  assert.equal(policy.decide().terminate, undefined)
  assert.equal(policy.decide().terminate, undefined)
  assert.deepEqual(policy.decide(), {
    selected: false,
    terminate: true,
    reason: "turn-cap-reached",
    turn: 3,
    calls: 0,
  })

  const response = terminalResponse(request(), { turn: 81 })
  const parsed = JSON.parse(response.body)
  assert.equal(parsed.choices[0].finish_reason, "stop")
  assert.match(parsed.choices[0].message.content, /80 turns/)
})

test("router does not forward the request after the executor turn cap", async () => {
  let forwarded = 0
  const upstream = http.createServer((_incoming, outgoing) => {
    forwarded += 1
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(JSON.stringify({ choices: [] }))
  })
  const upstreamPort = await listen(upstream)
  const policy = new RandomInterventionPolicy({ probability: 0, maxCalls: 1, maxTurns: 1, seed: "seed" })
  const router = createRouter({ upstreamBaseURL: `http://127.0.0.1:${upstreamPort}/v1`, policy })
  const routerPort = await listen(router)

  try {
    const first = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    })
    assert.equal(first.status, 200)
    assert.equal(forwarded, 1)

    const capped = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    })
    const cappedBody = await capped.json()
    assert.equal(cappedBody.choices[0].finish_reason, "stop")
    assert.equal(forwarded, 1)
  } finally {
    await close(router)
    await close(upstream)
  }
})

test("synthetic responses invoke the registered advisory tool without executor inference", () => {
  const response = syntheticResponse(request(), { selected: true, turn: 2, calls: 1 })
  const parsed = JSON.parse(response.body)
  const call = parsed.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, "advisory")
  assert.equal(call.function.arguments, "{}")
  assert.match(call.id, /^call_platform_advisor_/)
})

test("rewrites the synthetic tool exchange into a prefixed platform system message", () => {
  const messages = rewriteAutomatedAdvisorMessages([
    { role: "user", content: "Fix the bug" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_platform_advisor_1_1",
        type: "function",
        function: { name: "advisory", arguments: "{}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_platform_advisor_1_1",
      content: platformAdvisorMessage("Check the parser first."),
    },
  ])
  assert.deepEqual(messages, [
    { role: "user", content: "Fix the bug" },
    {
      role: "system",
      content: `${PLATFORM_ADVISOR_MESSAGE_PREFIX}\n\nCheck the parser first.`,
    },
  ])
})

test("drops a failed automated advisor exchange from executor context", () => {
  const failedMessages = [
    { role: "user", content: "Fix the bug" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_platform_advisor_1_1",
        type: "function",
        function: { name: "advisory", arguments: "{}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_platform_advisor_1_1",
      content: "The operation timed out.",
    },
  ]
  const messages = rewriteAutomatedAdvisorMessages(failedMessages)
  assert.deepEqual(messages, [{ role: "user", content: "Fix the bug" }])
  assert.deepEqual(stripAdvisoryTool({ model: "executor", messages: failedMessages }).messages, [
    { role: "user", content: "Fix the bug" },
  ])
})

test("selected turns bypass the executor and the following request contains only a platform message", async () => {
  const forwarded = []
  const upstream = http.createServer(async (incoming, outgoing) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(JSON.stringify({
      id: "executor-response",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Continue." }, finish_reason: "stop" }],
    }))
  })
  const upstreamPort = await listen(upstream)
  const policy = new RandomInterventionPolicy({ probability: 1, maxCalls: 1, seed: "seed" })
  const router = createRouter({ upstreamBaseURL: `http://127.0.0.1:${upstreamPort}/v1`, policy })
  const routerPort = await listen(router)

  try {
    const selected = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    })
    const selectedBody = await selected.json()
    const callID = selectedBody.choices[0].message.tool_calls[0].id
    assert.equal(forwarded.length, 0)

    const next = request({
      messages: [
        { role: "user", content: "Fix the bug" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: callID,
            type: "function",
            function: { name: "advisory", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: callID, content: platformAdvisorMessage("Check the parser first.") },
      ],
    })
    const executor = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    })
    assert.equal(executor.status, 200)
    assert.equal(forwarded.length, 1)
    assert.deepEqual(forwarded[0].tools.map((tool) => tool.function.name), ["bash"])
    assert.deepEqual(forwarded[0].messages, [
      { role: "user", content: "Fix the bug" },
      {
        role: "system",
        content: `${PLATFORM_ADVISOR_MESSAGE_PREFIX}\n\nCheck the parser first.`,
      },
    ])
  } finally {
    await close(router)
    await close(upstream)
  }
})

test("failed advice is hidden while still consuming the selected call", async () => {
  const forwarded = []
  const upstream = http.createServer(async (incoming, outgoing) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    outgoing.writeHead(200, { "content-type": "application/json" })
    outgoing.end(JSON.stringify({
      id: "executor-response",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Continue." }, finish_reason: "stop" }],
    }))
  })
  const upstreamPort = await listen(upstream)
  const policy = new RandomInterventionPolicy({ probability: 1, maxCalls: 1, seed: "seed" })
  const router = createRouter({ upstreamBaseURL: `http://127.0.0.1:${upstreamPort}/v1`, policy })
  const routerPort = await listen(router)

  try {
    const selected = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    })
    const selectedBody = await selected.json()
    const callID = selectedBody.choices[0].message.tool_calls[0].id

    const failed = request({
      messages: [
        { role: "user", content: "Fix the bug" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: callID,
            type: "function",
            function: { name: "advisory", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: callID, content: "The operation timed out." },
      ],
    })
    const resumed = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(failed),
    })
    assert.equal(resumed.status, 200)
    assert.deepEqual(forwarded[0].messages, [{ role: "user", content: "Fix the bug" }])

    const afterFailure = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    })
    assert.equal(afterFailure.status, 200)
    assert.equal(forwarded.length, 2)
    assert.equal(policy.calls, 1)
  } finally {
    await close(router)
    await close(upstream)
  }
})
