"use strict"

import crypto from "node:crypto"
import http from "node:http"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"
import {
  AUTOMATED_ADVISOR_CALL_PREFIX,
  rewriteAutomatedAdvisorMessages,
} from "./protocol.mjs"
import { FixedInterventionPolicy } from "./fixed-policy.mjs"
import { OpenJevInterventionPolicy } from "./openjev-policy.mjs"
import { parseAdvisorCallLimit } from "./policy-config.mjs"
import { writePlatformAdvisorContext } from "./platform-context.mjs"

const ADVISORY_TOOL_NAME = "advisory"

function toolName(tool) {
  return tool?.type === "function" ? tool.function?.name : undefined
}

export function stripAdvisoryTool(request) {
  if (!request || typeof request !== "object") return request
  const hasTools = Array.isArray(request.tools)
  const tools = hasTools
    ? request.tools.filter((candidate) => toolName(candidate) !== ADVISORY_TOOL_NAME)
    : request.tools
  let toolChoice = request.tool_choice
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.type === "function" &&
    toolChoice.function?.name === ADVISORY_TOOL_NAME
  ) {
    toolChoice = "auto"
  }
  return {
    ...request,
    ...(hasTools ? { tools } : {}),
    messages: rewriteAutomatedAdvisorMessages(request.messages),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  }
}

export function isEligibleExecutorTurn(request) {
  if (!request || typeof request !== "object" || !Array.isArray(request.tools)) return false
  const names = request.tools.map(toolName).filter(Boolean)
  return names.includes(ADVISORY_TOOL_NAME) && names.some((name) => name !== ADVISORY_TOOL_NAME)
}

export function deterministicDraw(seed, turn) {
  const digest = crypto.createHash("sha256").update(`${seed}\0${turn}`).digest()
  const top53 = digest.readBigUInt64BE(0) >> 11n
  return Number(top53) / 2 ** 53
}

export class RandomInterventionPolicy {
  constructor({ probability, maxCalls, maxTurns = 0, seed }) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("EVAL_ADVISOR_RANDOM_PROBABILITY must be between 0 and 1")
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0) {
      throw new Error("EVAL_EXECUTOR_MAX_TURNS must be a non-negative integer")
    }
    if (typeof seed !== "string" || !seed.trim()) {
      throw new Error("EVAL_ADVISOR_RANDOM_SEED must be non-empty")
    }
    this.probability = probability
    this.name = "random"
    this.maxCalls = parseAdvisorCallLimit(maxCalls)
    this.maxTurns = maxTurns
    this.seed = seed
    this.eligibleTurns = 0
    this.calls = 0
    this.forceExecutorNext = false
  }

  decide() {
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
    const draw = deterministicDraw(this.seed, turn)
    if (draw >= this.probability) {
      return { selected: false, reason: "random-draw", draw, turn, calls: this.calls }
    }
    this.calls += 1
    this.forceExecutorNext = true
    return { selected: true, reason: "random-draw", draw, turn, calls: this.calls }
  }

  readyMetadata() {
    return {
      probability: this.probability,
      max_calls: this.maxCalls,
      max_calls_unlimited: this.maxCalls === null,
      max_turns: this.maxTurns,
    }
  }
}

export function terminalResponse(request, decision) {
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-platform-turn-cap-${decision.turn}`
  const model = request.model || "platform-advisor-router"
  const content = `Platform executor turn limit reached after ${decision.turn - 1} turns.`
  if (request.stream === true) {
    const first = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    }
    const last = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    return {
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
    }
  }
  return {
    contentType: "application/json",
    body: JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  }
}

export function automatedAdvisorCallID(decision) {
  return `${AUTOMATED_ADVISOR_CALL_PREFIX}${decision.turn}_${decision.calls}`
}

function syntheticCompletion(request, decision) {
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-platform-advisor-${decision.turn}-${decision.calls}`
  const callID = automatedAdvisorCallID(decision)
  const toolCall = {
    id: callID,
    type: "function",
    function: { name: ADVISORY_TOOL_NAME, arguments: "{}" },
  }
  return { created, id, callID, model: request.model || "platform-advisor-router", toolCall }
}

export function syntheticResponse(request, decision) {
  const completion = syntheticCompletion(request, decision)
  if (request.stream === true) {
    const first = {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{
        index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, ...completion.toolCall }] },
        finish_reason: null,
      }],
    }
    const last = {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    return {
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
    }
  }
  return {
    contentType: "application/json",
    body: JSON.stringify({
      id: completion.id,
      object: "chat.completion",
      created: completion.created,
      model: completion.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [completion.toolCall],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  }
}

function upstreamURL(base, requestURL) {
  const upstream = new URL(base)
  const incoming = new URL(requestURL, "http://router.invalid")
  const suffix = incoming.pathname.replace(/^\/v1(?=\/|$)/, "")
  upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}${suffix}`
  upstream.search = incoming.search
  return upstream
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function logDecision(policy, decision) {
  process.stderr.write(`${JSON.stringify({ event: "advisor.intervention.decision", policy, ...decision })}\n`)
}

function requestHeaders(headers) {
  const forwarded = { ...headers, "accept-encoding": "identity" }
  for (const name of [
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) delete forwarded[name]
  return forwarded
}

function responseHeaders(headers) {
  const forwarded = Object.fromEntries(headers.entries())
  for (const name of [
    "content-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
  ]) delete forwarded[name]
  return forwarded
}

export function createRouter({ upstreamBaseURL, policy }) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.split("?", 1)[0] === "/health") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ status: "ok", policy: policy.name }))
        return
      }
      const rawBody = await readBody(request)
      const isChatCompletion = request.method === "POST" && request.url?.split("?", 1)[0].endsWith("/chat/completions")
      let outgoingBody = rawBody

      if (isChatCompletion) {
        const parsed = JSON.parse(rawBody.toString("utf8"))
        if (isEligibleExecutorTurn(parsed)) {
          const decision = await policy.decide(parsed)
          logDecision(policy.name, decision)
          if (decision.terminate) {
            const terminal = terminalResponse(parsed, decision)
            response.writeHead(200, {
              "content-type": terminal.contentType,
              "cache-control": "no-cache",
              connection: "close",
            })
            response.end(terminal.body)
            return
          }
          if (decision.selected) {
            const advisorContext = typeof policy.takeAdvisorContext === "function"
              ? policy.takeAdvisorContext()
              : null
            if (advisorContext !== null && advisorContext !== undefined) {
              writePlatformAdvisorContext(automatedAdvisorCallID(decision), advisorContext)
            }
            const synthetic = syntheticResponse(parsed, decision)
            response.writeHead(200, {
              "content-type": synthetic.contentType,
              "cache-control": "no-cache",
              connection: "keep-alive",
            })
            response.end(synthetic.body)
            return
          }
        }
        outgoingBody = Buffer.from(JSON.stringify(stripAdvisoryTool(parsed)))
      }

      const upstreamResponse = await fetch(upstreamURL(upstreamBaseURL, request.url || "/"), {
        method: request.method,
        headers: requestHeaders(request.headers),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : outgoingBody,
        redirect: "manual",
      })
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers))
      if (!upstreamResponse.body) {
        response.end()
        return
      }
      Readable.fromWeb(upstreamResponse.body).pipe(response)
    } catch (error) {
      process.stderr.write(`opencode-advisory: intervention router request failed: ${error.name}\n`)
      response.writeHead(502, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "advisor intervention router failed" } }))
    }
  })
}

function envConfig() {
  return {
    host: process.env.EVAL_ADVISOR_ROUTER_HOST || "127.0.0.1",
    port: Number(process.env.EVAL_ADVISOR_ROUTER_PORT || "8012"),
    upstreamBaseURL: process.env.EVAL_ADVISOR_EXECUTOR_BASE_URL || "",
    probability: Number(process.env.EVAL_ADVISOR_RANDOM_PROBABILITY),
    maxCalls: process.env.EVAL_ADVISOR_MAX_CALLS || "",
    maxTurns: Number(process.env.EVAL_EXECUTOR_MAX_TURNS || "0"),
    seed: process.env.EVAL_ADVISOR_RANDOM_SEED || "",
    policyName: process.env.EVAL_ADVISOR_INVOCATION_POLICY || "random",
    openjevBaseURL: process.env.OPENJEV_BASE_URL || "",
    openjevApiKey: process.env.OPENJEV_API_KEY || "",
    openjevTimeoutSeconds: Number(process.env.EVAL_ADVISOR_OPENJEV_TIMEOUT_SECONDS || "30"),
    openjevInterval: process.env.EVAL_ADVISOR_OPENJEV_INTERVAL || "1",
    openjevPolicyConfig: process.env.EVAL_ADVISOR_OPENJEV_POLICY_CONFIG || "",
    fixedTurn: process.env.EVAL_ADVISOR_FIXED_TURN || "",
    fixedInterval: process.env.EVAL_ADVISOR_FIXED_INTERVAL || "",
  }
}

function createPolicy(config) {
  if (config.policyName === "random") {
    return new RandomInterventionPolicy(config)
  }
  if (config.policyName === "openjev") {
    return new OpenJevInterventionPolicy({
      baseURL: config.openjevBaseURL,
      apiKey: config.openjevApiKey,
      timeoutSeconds: config.openjevTimeoutSeconds,
      interval: config.openjevInterval,
      maxCalls: config.maxCalls,
      maxTurns: config.maxTurns,
      policyConfig: config.openjevPolicyConfig,
    })
  }
  if (config.policyName === "fixed") {
    return new FixedInterventionPolicy({
      turn: config.fixedTurn,
      interval: config.fixedInterval,
      maxCalls: config.maxCalls,
      maxTurns: config.maxTurns,
    })
  }
  throw new Error("EVAL_ADVISOR_INVOCATION_POLICY must be random, openjev, or fixed for the intervention router")
}

export function startRouter(config = envConfig()) {
  if (!config.upstreamBaseURL) throw new Error("EVAL_ADVISOR_EXECUTOR_BASE_URL must be configured")
  if (!Number.isSafeInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("EVAL_ADVISOR_ROUTER_PORT must be a valid TCP port")
  }
  const policy = createPolicy(config)
  const server = createRouter({ upstreamBaseURL: config.upstreamBaseURL, policy })
  server.listen(config.port, config.host, () => {
    process.stderr.write(`${JSON.stringify({ event: "advisor.intervention.router.ready", policy: policy.name, host: config.host, port: config.port, ...policy.readyMetadata() })}\n`)
  })
  return server
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    startRouter()
  } catch (error) {
    process.stderr.write(`opencode-advisory: ${error.message}\n`)
    process.exit(2)
  }
}
