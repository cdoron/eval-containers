import assert from "node:assert/strict"
import test from "node:test"
import { buildSessionContext, serializeSessionContext } from "./session-context.mjs"

function exportedSession() {
  return {
    info: { id: "session-1" },
    messages: [
      {
        info: { id: "user-1", role: "user" },
        parts: [{ type: "text", text: "Fix the bug" }],
      },
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [
          { type: "reasoning", text: "Inspect the failing path" },
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "pwd" }, output: "/app" },
          },
          {
            type: "tool",
            tool: "advisory",
            state: {
              status: "completed",
              input: { request: "old request", context: "old duplicated context" },
              output: "Earlier advice",
              metadata: { request_payload: "duplicated" },
            },
          },
        ],
      },
      {
        info: { id: "assistant-current", role: "assistant" },
        parts: [
          { type: "reasoning", text: "Ask the advisor now" },
          {
            type: "tool",
            tool: "advisory",
            messageID: "assistant-current",
            state: {
              status: "completed",
              input: { request: "same-message old request", context: "duplicate" },
              output: "Same-message earlier advice",
            },
          },
          {
            type: "tool",
            tool: "advisory",
            messageID: "assistant-current",
            state: { status: "running", input: {} },
          },
        ],
      },
    ],
  }
}

test("keeps chronological context and excludes only the active advisory call", () => {
  const context = buildSessionContext({
    session: exportedSession(),
    currentMessageID: "assistant-current",
    task: "Original benchmark task",
    executorSystemPrompt: "Executor instruction",
    advisorToolDescription: "Ask for advice",
  })

  assert.equal(context.task, "Original benchmark task")
  assert.equal(context.executor_system_prompt, "Executor instruction")
  assert.equal(context.advisor_tool_description, "Ask for advice")
  assert.deepEqual(context.messages.map((message) => message.info.id), [
    "user-1",
    "assistant-1",
    "assistant-current",
  ])
  assert.equal(context.messages[2].parts[0].text, "Ask the advisor now")
  assert.equal(context.messages[2].parts.length, 2)
  assert.equal(context.messages[2].parts[1].state.output, "Same-message earlier advice")
  assert.equal(context.messages[2].parts[1].state.input, undefined)
})

test("keeps previous advice without its duplicated request and context", () => {
  const context = buildSessionContext({
    session: exportedSession(),
    currentMessageID: "assistant-current",
    task: "task",
    executorSystemPrompt: "",
    advisorToolDescription: "description",
  })
  const previousAdvice = context.messages[1].parts[2]

  assert.equal(previousAdvice.state.output, "Earlier advice")
  assert.equal(previousAdvice.state.input, undefined)
  assert.equal(previousAdvice.state.metadata, undefined)
  assert.deepEqual(context.messages[1].parts[1].state.input, { command: "pwd" })
})

test("fails instead of truncating context over the configured byte limit", () => {
  const options = {
    session: exportedSession(),
    currentMessageID: "assistant-current",
    task: "task",
    executorSystemPrompt: "",
    advisorToolDescription: "description",
  }
  const serialized = serializeSessionContext(options, 0)

  assert.throws(
    () => serializeSessionContext(options, Buffer.byteLength(serialized) - 1),
    /exceeding EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES/,
  )
})
