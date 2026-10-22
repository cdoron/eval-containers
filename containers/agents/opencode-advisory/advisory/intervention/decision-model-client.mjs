"use strict"

export const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 502, 503, 504])

export function nonNegativeInteger(value, name) {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function responseBody(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.slice(0, 500) } }
  }
}

export function responseError(body) {
  return body?.error && typeof body.error === "object" ? body.error : {}
}

export function isContextOverflow(response, body) {
  const error = responseError(body)
  const code = String(error.code || error.type || "").toLowerCase()
  const message = String(error.message || "").toLowerCase()
  return response.status === 413 || code.includes("context") || message.includes("context length")
}

export async function requestDecisionModel({
  url,
  apiKey,
  payload,
  target,
  timeoutSeconds,
  transientRetries,
  retryDelaySeconds,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  for (let attempt = 0; attempt <= transientRetries; attempt += 1) {
    let response
    let body
    try {
      response = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      })
      body = await responseBody(response)
    } catch (error) {
      const transportError = error instanceof Error ? error : new Error(String(error))
      transportError.transientRetries = attempt
      if (attempt >= transientRetries) throw transportError
      process.stderr.write(`${JSON.stringify({
        event: "advisor.decision_model.retry",
        target,
        retry: attempt + 1,
        retries: transientRetries,
        delay_seconds: retryDelaySeconds,
        detail: transportError.message,
      })}\n`)
      await sleepImpl(retryDelaySeconds * 1000)
      continue
    }
    if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt >= transientRetries) {
      return { response, body, transientRetries: attempt }
    }
    process.stderr.write(`${JSON.stringify({
      event: "advisor.decision_model.retry",
      target,
      retry: attempt + 1,
      retries: transientRetries,
      delay_seconds: retryDelaySeconds,
      detail: `HTTP ${response.status}`,
    })}\n`)
    await sleepImpl(retryDelaySeconds * 1000)
  }
  throw new Error(`${target} retry loop ended unexpectedly`)
}
