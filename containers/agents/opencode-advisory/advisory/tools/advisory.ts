import { tool } from "@opencode-ai/plugin"
import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
// @ts-ignore This absolute path is populated by the agent image.
import { serializeSessionContext } from "/opt/agent/advisory/context/session-context.mjs"

const DESCRIPTIONS_FILE = "/opt/agent/advisory/tool-descriptions.json"
const EXECUTOR_PROMPT_FILE = "/home/agent/.config/opencode/executor-system-prompt.txt"
const CONTEXT_MODES = new Set(["agent-provided", "full-session"])

function loadCatalog(): Record<string, unknown> {
  const raw = (process.env.EVAL_ADVISORY_CONFIG || "").trim()
  if (!raw) return {}
  const catalog = JSON.parse(raw)
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("EVAL_ADVISORY_CONFIG must be a JSON object")
  }
  return catalog as Record<string, unknown>
}

function loadDescription(): { text: string; variant: string } {
  const custom = (process.env.EVAL_ADVISOR_TOOL_DESCRIPTION || "").trim()
  const configuredVariant = (process.env.EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT || "").trim()
  if (custom && configuredVariant) {
    throw new Error("Choose either EVAL_ADVISOR_TOOL_DESCRIPTION or EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT")
  }
  if (custom) return { text: custom, variant: "custom" }

  const variant = configuredVariant || "neutral"
  const catalog = loadCatalog()
  const external = catalog.tool_descriptions
  if (external && typeof external === "object" && !Array.isArray(external)) {
    const value = (external as Record<string, unknown>)[variant]
    if (typeof value === "string" && value.trim()) {
      return { text: value.trim(), variant }
    }
  }
  const builtInVariant = variant.toLowerCase()
  const descriptions = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, "utf8"))
  if (typeof descriptions[builtInVariant] !== "string" || !descriptions[builtInVariant].trim()) {
    throw new Error(`Unknown advisor tool description variant '${variant}'`)
  }
  return { text: descriptions[builtInVariant].trim(), variant: builtInVariant }
}

const resolvedDescription = loadDescription()

function contextMode(): string {
  const value = (process.env.EVAL_ADVISOR_CONTEXT_MODE || "agent-provided").trim()
  if (!CONTEXT_MODES.has(value)) {
    throw new Error("EVAL_ADVISOR_CONTEXT_MODE must be 'agent-provided' or 'full-session'")
  }
  return value
}

function fullContextMaxBytes(): number {
  const raw = (process.env.EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES || "0").trim()
  if (!/^\d+$/.test(raw)) {
    throw new Error("EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES must be a non-negative integer")
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error("EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES is too large")
  }
  return value
}

async function exportSession(sessionID: string, directory: string): Promise<unknown> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-advisory-"))
  const outputPath = path.join(temporaryDirectory, "session.json")
  let output = fs.openSync(outputPath, "wx", 0o600)
  try {
    const child = spawn("opencode", ["export", sessionID], {
      cwd: directory,
      env: process.env,
      stdio: ["ignore", output, "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve(code ?? 1))
    })
    fs.closeSync(output)
    output = -1
    if (exitCode !== 0) {
      throw new Error(`opencode export failed with exit code ${exitCode}: ${stderr.trim()}`)
    }
    return JSON.parse(fs.readFileSync(outputPath, "utf8"))
  } finally {
    if (output >= 0) fs.closeSync(output)
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function requestAdvice(request: string, context: string): Promise<string> {
  const gateway = (process.env.ADVISORY_GATEWAY_URL || "http://advisor:8001").replace(/\/$/, "")
  const experimentId = process.env.ADVISORY_EXPERIMENT_ID || null

  const res = await fetch(`${gateway}/advisory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request,
      context,
      experiment_id: experimentId,
      harness: "opencode-eval-containers",
      description_variant: resolvedDescription.variant,
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
}

const mode = contextMode()

// Native opencode tool — opencode itself executes this, independent of
// whatever execution channel (shell, sandboxed REPL, ...) the benchmark exposes.
export default mode === "full-session"
  ? tool({
      description: resolvedDescription.text,
      args: {},
      async execute(_args, toolContext) {
        const task = (process.env.TASK || "").trim()
        if (!task) throw new Error("TASK is required for full-session advisor context")
        const session = await exportSession(toolContext.sessionID, toolContext.directory)
        const executorSystemPrompt = fs.existsSync(EXECUTOR_PROMPT_FILE)
          ? fs.readFileSync(EXECUTOR_PROMPT_FILE, "utf8")
          : (process.env.EVAL_EXECUTOR_SYSTEM_PROMPT || "")
        const context = serializeSessionContext({
          session,
          currentMessageID: toolContext.messageID,
          task,
          executorSystemPrompt,
          advisorToolDescription: resolvedDescription.text,
        }, fullContextMaxBytes())
        return requestAdvice(task, context)
      },
    })
  : tool({
      description: resolvedDescription.text,
      args: {
        request: tool.schema.string().describe("The situation, question, plan, alternatives, or proposed solution to analyze."),
        context: tool.schema.string().describe("Relevant reasoning, plan, observations, actions, results, errors, and constraints accumulated so far."),
      },
      async execute(args) {
        return requestAdvice(args.request, args.context)
      },
    })
