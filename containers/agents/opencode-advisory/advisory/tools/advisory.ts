import { tool } from "@opencode-ai/plugin"
import fs from "fs"

const DESCRIPTIONS_FILE = "/opt/agent/advisory/tool-descriptions.json"

function loadDescription(): string {
  const custom = (process.env.ADVISOR_TOOL_DESCRIPTION || "").trim()
  if (custom) return custom

  const variant = (
    process.env.ADVISOR_TOOL_DESCRIPTION_VARIANT ||
    "neutral"
  ).trim().toLowerCase()
  const descriptions = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, "utf8"))
  if (typeof descriptions[variant] !== "string" || !descriptions[variant].trim()) {
    throw new Error(`Unknown advisor tool description variant '${variant}' in ${DESCRIPTIONS_FILE}`)
  }
  return descriptions[variant].trim()
}

// Native opencode tool — opencode itself executes this, independent of
// whatever execution channel (shell, sandboxed REPL, ...) the benchmark exposes.
export default tool({
  description: loadDescription(),
  args: {
    request: tool.schema.string().describe("The situation, question, plan, alternatives, or proposed solution to analyze."),
    context: tool.schema.string().describe("Relevant reasoning, plan, observations, actions, results, errors, and constraints accumulated so far."),
  },
  async execute(args) {
    const gateway = (process.env.ADVISORY_GATEWAY_URL || "http://advisor:8001").replace(/\/$/, "")
    const variant = process.env.ADVISOR_TOOL_DESCRIPTION
      ? "custom"
      : process.env.ADVISOR_TOOL_DESCRIPTION_VARIANT || "neutral"
    const experimentId = process.env.ADVISORY_EXPERIMENT_ID || null

    const res = await fetch(`${gateway}/advisory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: args.request,
        context: args.context,
        experiment_id: experimentId,
        harness: "opencode-eval-containers",
        description_variant: variant,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Advisory service returned HTTP ${res.status}: ${body}`)
    }

    const parsed = await res.json()
    if (!parsed.advice || typeof parsed.advice !== "string" || !parsed.advice.trim()) {
      throw new Error(`Advisory service returned no advice: ${JSON.stringify(parsed)}`)
    }
    return parsed.advice.trim()
  },
})
