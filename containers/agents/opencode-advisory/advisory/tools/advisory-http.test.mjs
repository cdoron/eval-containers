import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { advisorTimeoutMilliseconds, postJson } from "./advisory-http.mjs"

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  return {
    server,
    url: `http://127.0.0.1:${address.port}/advisory`,
  }
}

test("advisorTimeoutMilliseconds reads the configured per-attempt timeout", () => {
  assert.equal(advisorTimeoutMilliseconds({ EVAL_ADVISOR_TIMEOUT_SECONDS: "17" }), 17_000)
})

test("postJson sends JSON and returns the response", async (t) => {
  let receivedBody = ""
  const { server, url } = await listen((request, response) => {
    request.setEncoding("utf8")
    request.on("data", (chunk) => { receivedBody += chunk })
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"advice":"check parser.py"}')
    })
  })
  t.after(() => server.close())

  const result = await postJson(url, { request: "review this" }, 1_000)

  assert.deepEqual(result, {
    statusCode: 200,
    body: '{"advice":"check parser.py"}',
  })
  assert.deepEqual(JSON.parse(receivedBody), { request: "review this" })
})

test("postJson aborts a hanging response at the configured timeout", async (t) => {
  const { server, url } = await listen((_request, _response) => {})
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))

  await assert.rejects(
    postJson(url, { request: "review this" }, 25),
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR",
  )
})
