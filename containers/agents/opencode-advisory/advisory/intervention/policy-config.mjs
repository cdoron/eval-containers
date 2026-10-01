"use strict"

export function parseOptionalPositiveInteger(value, variableName) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new Error(`${variableName} must be a positive integer`)
}

export function parseAdvisorCallLimit(value) {
  if (value === undefined || value === null || value === "" || value === "unlimited") return null
  try {
    return parseOptionalPositiveInteger(value, "EVAL_ADVISOR_MAX_CALLS")
  } catch {
    throw new Error("EVAL_ADVISOR_MAX_CALLS must be a positive integer, 'unlimited', or omitted")
  }
}
