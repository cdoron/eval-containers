import assert from "node:assert/strict"
import test from "node:test"
import { FixedInterventionPolicy } from "./fixed-policy.mjs"

test("selects exactly one configured executor turn", () => {
  const policy = new FixedInterventionPolicy({ turn: "3" })
  assert.equal(policy.decide().selected, false)
  assert.equal(policy.decide().selected, false)
  assert.equal(policy.decide().reason, "fixed-turn")
  assert.equal(policy.decide().reason, "post-advisor-executor-turn")
  assert.equal(policy.decide().selected, false)
  assert.equal(policy.calls, 1)
})

test("selects recurring turns while preserving a normal executor turn", () => {
  const policy = new FixedInterventionPolicy({ interval: "2", maxCalls: "2" })
  assert.equal(policy.decide().selected, false)
  assert.equal(policy.decide().reason, "fixed-interval")
  assert.equal(policy.decide().reason, "post-advisor-executor-turn")
  assert.equal(policy.decide().reason, "fixed-interval")
  assert.equal(policy.decide().reason, "post-advisor-executor-turn")
  assert.equal(policy.decide().reason, "call-cap-reached")
})

test("requires exactly one fixed schedule", () => {
  assert.throws(() => new FixedInterventionPolicy({}), /exactly one/)
  assert.throws(
    () => new FixedInterventionPolicy({ turn: "2", interval: "4" }),
    /exactly one/,
  )
  assert.throws(() => new FixedInterventionPolicy({ turn: "0" }), /positive integer/)
})
