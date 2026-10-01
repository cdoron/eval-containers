"use strict"

import { parseAdvisorCallLimit, parseOptionalPositiveInteger } from "./policy-config.mjs"

export class FixedInterventionPolicy {
  constructor({ turn, interval, maxCalls, maxTurns = 0 }) {
    this.fixedTurn = parseOptionalPositiveInteger(turn, "EVAL_ADVISOR_FIXED_TURN")
    this.interval = parseOptionalPositiveInteger(interval, "EVAL_ADVISOR_FIXED_INTERVAL")
    if ((this.fixedTurn === null) === (this.interval === null)) {
      throw new Error("fixed advisor invocation requires exactly one of EVAL_ADVISOR_FIXED_TURN or EVAL_ADVISOR_FIXED_INTERVAL")
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0) {
      throw new Error("EVAL_EXECUTOR_MAX_TURNS must be a non-negative integer")
    }
    this.name = "fixed"
    this.maxCalls = parseAdvisorCallLimit(maxCalls)
    this.maxTurns = maxTurns
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

    const selected = this.fixedTurn !== null
      ? turn === this.fixedTurn
      : turn % this.interval === 0
    if (!selected) {
      return { selected: false, reason: "fixed-schedule", turn, calls: this.calls }
    }
    this.calls += 1
    this.forceExecutorNext = true
    return {
      selected: true,
      reason: this.fixedTurn !== null ? "fixed-turn" : "fixed-interval",
      turn,
      calls: this.calls,
    }
  }

  readyMetadata() {
    return {
      fixed_turn: this.fixedTurn,
      fixed_interval: this.interval,
      max_calls: this.maxCalls,
      max_calls_unlimited: this.maxCalls === null,
      max_turns: this.maxTurns,
    }
  }
}
