import assert from "node:assert/strict"
import test from "node:test"
import { buildSessionContext, serializeSessionContext } from "./session-context.mjs"

function exportedSession() {
  return {
    info: { id: "session-1" },
    messages: [
      {
        info: {
          id: "user-1",
          role: "user",
          time: { created: 1 },
          summary: { diffs: [{ file: "large.py", patch: "internal diff" }] },
        },
        parts: [{ type: "text", text: "Fix the bug", id: "part-user", sessionID: "session-1" }],
      },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          cost: 1,
          tokens: { input: 100, output: 10 },
        },
        parts: [
          { type: "step-start", snapshot: "internal snapshot" },
          { type: "reasoning", text: "Inspect the failing path", metadata: { signature: "internal" } },
          {
            type: "tool",
            tool: "bash",
            callID: "call-bash",
            state: {
              status: "completed",
              input: { command: "pwd" },
              output: "/app",
              metadata: { output: "/app", preview: "/app" },
              time: { start: 1, end: 2 },
            },
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
          { type: "step-finish", snapshot: "internal snapshot", tokens: { input: 100 } },
        ],
      },
      {
        info: { id: "assistant-current", role: "assistant" },
        parts: [
          { type: "text", text: "Ask the advisor now" },
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

test("keeps chronological model-visible context and excludes active advisory call", () => {
  const context = buildSessionContext({
    session: exportedSession(),
    currentMessageID: "assistant-current",
    executorSystemPrompt: "Executor instruction",
  })

  assert.equal(context.schema_version, 2)
  assert.equal(context.executor_system_prompt, "Executor instruction")
  assert.deepEqual(context.messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
    "assistant",
    "tool",
  ])
  assert.equal(context.messages[0].content, "Fix the bug")
  assert.equal(context.messages[1].reasoning, "Inspect the failing path")
  assert.deepEqual(context.messages[1].tool_calls, [
    { name: "bash", input: { command: "pwd" } },
    { name: "advisory" },
  ])
  assert.equal(context.messages[2].content, "/app")
  assert.equal(context.messages[3].content, "Earlier advice")
  assert.equal(context.messages[4].content, "Ask the advisor now")
  assert.deepEqual(context.messages[4].tool_calls, [{ name: "advisory" }])
  assert.equal(context.messages[5].content, "Same-message earlier advice")
})

test("removes OpenCode bookkeeping and duplicated tool metadata", () => {
  const serialized = serializeSessionContext({
    session: exportedSession(),
    currentMessageID: "assistant-current",
    executorSystemPrompt: "",
  })

  for (const excluded of [
    "internal diff",
    "internal snapshot",
    "old duplicated context",
    "same-message old request",
    '"sessionID"',
    '"messageID"',
    '"callID"',
    '"metadata"',
    '"tokens"',
  ]) {
    assert.equal(serialized.includes(excluded), false, excluded)
  }
})

test("uses OpenCode's completed compaction boundary", () => {
  const session = {
    messages: [
      { info: { id: "old-user", role: "user" }, parts: [{ type: "text", text: "Old raw task" }] },
      { info: { id: "compact-user", role: "user" }, parts: [{ type: "compaction" }] },
      {
        info: {
          id: "summary",
          parentID: "compact-user",
          role: "assistant",
          summary: true,
          finish: "stop",
        },
        parts: [{ type: "text", text: "Compact summary of earlier work" }],
      },
      {
        info: { id: "current", role: "assistant" },
        parts: [{ type: "text", text: "Work after compaction" }],
      },
    ],
  }

  const context = buildSessionContext({ session, currentMessageID: "current", executorSystemPrompt: "" })

  assert.deepEqual(context.messages, [
    { role: "user", content: "What did we do so far?" },
    { role: "assistant", content: "Compact summary of earlier work" },
    { role: "assistant", content: "Work after compaction" },
  ])
})

test("uses the executor placeholder for compacted tool output", () => {
  const session = {
    messages: [{
      info: { id: "assistant-1", role: "assistant" },
      parts: [{
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/large/file" },
          output: "large cleared output",
          time: { compacted: 1 },
        },
      }],
    }],
  }

  const context = buildSessionContext({ session, currentMessageID: "current", executorSystemPrompt: "" })

  assert.equal(context.messages[1].content, "[Old tool result content cleared]")
})

test("matches OpenCode handling of failed, aborted, and interrupted turns", () => {
  const session = {
    messages: [
      {
        info: { id: "failed", role: "assistant", error: { name: "APIError" } },
        parts: [{ type: "text", text: "failed turn must not reach the model" }],
      },
      {
        info: { id: "empty-abort", role: "assistant", error: { name: "MessageAbortedError" } },
        parts: [{ type: "reasoning", text: "unfinished private reasoning" }],
      },
      {
        info: { id: "useful-abort", role: "assistant", error: { name: "MessageAbortedError" } },
        parts: [{
          type: "tool",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "long-running-command" },
            error: "interrupted",
            metadata: { interrupted: true, output: "partial useful output" },
          },
        }],
      },
    ],
  }

  const context = buildSessionContext({ session, currentMessageID: "current", executorSystemPrompt: "" })

  assert.deepEqual(context.messages, [
    { role: "assistant", tool_calls: [{ name: "bash", input: { command: "long-running-command" } }] },
    { role: "tool", name: "bash", status: "error", content: "partial useful output" },
  ])
})

test("fails instead of truncating context over the configured byte limit", () => {
  const options = {
    session: exportedSession(),
    currentMessageID: "assistant-current",
    executorSystemPrompt: "",
  }
  const serialized = serializeSessionContext(options, 0)

  assert.throws(
    () => serializeSessionContext(options, Buffer.byteLength(serialized) - 1),
    /exceeding EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES/,
  )
})
