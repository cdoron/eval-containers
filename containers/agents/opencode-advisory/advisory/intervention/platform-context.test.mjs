import assert from "node:assert/strict"
import test from "node:test"
import { takePlatformAdvisorContext, writePlatformAdvisorContext } from "./platform-context.mjs"

test("stores platform context for exactly one advisor tool execution", () => {
  const callID = `call_platform_advisor_test_${process.pid}_${Date.now()}`
  const context = JSON.stringify({ turn: 3, messages: [{ role: "user", content: "Fix it" }] })
  writePlatformAdvisorContext(callID, context)
  assert.equal(takePlatformAdvisorContext(callID), context)
  assert.equal(takePlatformAdvisorContext(callID), null)
})

test("rejects non-platform call identifiers", () => {
  assert.throws(() => takePlatformAdvisorContext("call_executor_tool_1"), /invalid platform/)
})
