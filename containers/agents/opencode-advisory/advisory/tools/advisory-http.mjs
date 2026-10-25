import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

export function advisorTimeoutMilliseconds(env = process.env) {
  const raw = (env.EVAL_ADVISOR_TIMEOUT_SECONDS || "300").trim()
  if (!/^\d+$/.test(raw)) {
    throw new Error("EVAL_ADVISOR_TIMEOUT_SECONDS must be an integer from 1 to 86400")
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86400) {
    throw new Error("EVAL_ADVISOR_TIMEOUT_SECONDS must be an integer from 1 to 86400")
  }
  return value * 1000
}

export async function postJson(
  url,
  payload,
  timeoutMilliseconds = advisorTimeoutMilliseconds(),
) {
  const target = new URL(url)
  const body = JSON.stringify(payload)
  const request = target.protocol === "https:" ? httpsRequest : httpRequest

  return new Promise((resolve, reject) => {
    const req = request(target, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMilliseconds),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      res.once("error", reject)
      res.once("end", () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }))
    })
    req.once("error", reject)
    req.end(body)
  })
}
