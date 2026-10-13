import assert from "node:assert/strict"
import test from "node:test"
import { readPlatformAdvisorContext, writePlatformAdvisorContext } from "./platform-context.mjs"

test("returns the same platform context for retried advisor tool executions", () => {
  const callID = `call_platform_advisor_test_${process.pid}_${Date.now()}`
  const context = JSON.stringify({ turn: 3, messages: [{ role: "user", content: "Fix it" }] })
  writePlatformAdvisorContext(callID, context)
  assert.equal(readPlatformAdvisorContext(callID), context)
  assert.equal(readPlatformAdvisorContext(callID), context)
})

test("rejects non-platform call identifiers", () => {
  assert.throws(() => readPlatformAdvisorContext("call_executor_tool_1"), /invalid platform/)
})
