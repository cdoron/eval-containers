# opencode-advisory

SST OpenCode with a native `advisory` tool and an agent-owned HTTP service that
calls an independently configured advisor model.

| Field | Value |
|---|---|
| Upstream | [sst/opencode](https://github.com/sst/opencode) |
| Version | `1.4.3` |
| Runtime | Node.js 22 plus Python 3 for the advisor service |
| Supported mode | Compose |

## Runtime flow

```text
executor OpenCode -> advisory tool -> advisor sidecar -> advisor model endpoint
              \-> executor gateway -> executor model
```

The sidecar is built into the same agent image and started with a different
entrypoint by the agent-owned [`compose.yaml`](compose.yaml) overlay. Compose
waits for `/health` before starting the runner. The overlay is currently
Compose-only, so the CLI and experiment validator reject other modes for this
agent.

The native tool lives in
[`advisory/tools/advisory.ts`](advisory/tools/advisory.ts). OpenCode executes
it directly, so it works with both real-shell benchmarks such as SWE-bench and
sandboxed execution bridges such as AppWorld.

## Configurable text

Three independent values can be changed for experiments:

- executor system-prompt addition;
- advisor system prompt;
- advisory tool description.

Each accepts exactly one source:

1. inline text;
2. a host text file, read by the CLI before Compose starts; or
3. a named string from an external JSON catalog.

The six built-in tool-description variants remain available without a catalog:
`conservative`, `encouraging`, `mandatory`, `neutral`, `prescriptive`, and
`uncertainty`. `neutral` is the default. The advisor system prompt also has a
built-in `default`. Executor system-prompt injection is off unless selected.

An external catalog has three named maps:

```json
{
  "executor_system_prompts": {"review-first": "..."},
  "advisor_system_prompts": {"concise": "..."},
  "tool_descriptions": {"reviewer": "..."}
}
```

[`experiments/advisory-config.example.json`](../../../experiments/advisory-config.example.json)
is a complete example. `--advisory-config-file` reads that host file and passes
the JSON to both containers as `EVAL_ADVISORY_CONFIG`; no extra Compose mount is
required. Plain Compose users can set the same value with
`EVAL_ADVISORY_CONFIG="$(cat config.json)"`.

## CLI configuration

| Purpose | Inline | Host file | Named catalog entry |
|---|---|---|---|
| Executor system prompt | `--executor-system-prompt` | `--executor-system-prompt-file` | `--executor-system-prompt-variant` |
| Advisor system prompt | `--advisor-system-prompt` | `--advisor-system-prompt-file` | `--advisor-system-prompt-variant` |
| Tool description | `--advisor-tool-description` | `--advisor-tool-description-file` | `--advisor-tool-description-variant` |

Named executor or advisor-system variants require `--advisory-config-file` or
`--advisory-config`. Tool variants first check the external catalog and then
the six built-ins. Selecting two sources for one value fails before the run.

## Advisor context

The default `agent-provided` mode keeps the existing tool contract: OpenCode
writes a `request` and `context` argument for each advisory call. Set
`--advisor-context-mode full-session` to make the tool take no arguments and
instead send:

- the original benchmark task as the advisor request;
- the configured executor system-prompt addition and resolved advisory tool
  description;
- the active OpenCode session in chronological order, including exposed
  reasoning, tool calls, results, and errors.

The active advisory call is removed to prevent recursion. Earlier advisory
responses stay in place, but their old request/context inputs are removed so
the complete session is not recursively duplicated. OpenCode does not expose
its built-in base system prompt to custom tools, so only the configured
executor addition can be included.

`--advisor-full-context-max-bytes <n>` sets a serialized byte limit. A value of
`0` means unlimited. Exceeding a nonzero limit fails the tool call explicitly;
the context is never summarized or silently truncated.

Service settings remain separate from experimental text:

| Variable / flag | Purpose |
|---|---|
| `ADVISOR_BASE_URL` / `--advisor-base-url` | OpenAI-compatible advisor endpoint |
| `ADVISOR_API_KEY` | Advisor endpoint credential; environment only |
| `ADVISOR_MODEL` / `--advisor-model` | Advisor model, independent of executor `--model` |
| `ADVISOR_LOG_PAYLOADS` / `--advisor-log-payloads` | Optional request/response logging |
| `ADVISORY_EXPERIMENT_ID` / `--experiment-id` | Experiment label attached to advisor spans |
| `EVAL_ADVISOR_CONTEXT_MODE` / `--advisor-context-mode` | `agent-provided` or `full-session` |
| `EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES` / `--advisor-full-context-max-bytes` | Full-session size limit; `0` is unlimited |

Do not commit credentials. See
[`advisory/service/.env.example`](advisory/service/.env.example) for safe
placeholders.

The executor and advisor credentials are independent. Put all four values in
the repository `.env` when using this agent:

```dotenv
OPENAI_API_BASE=https://executor.example.com/v1
OPENAI_API_KEY=replace-with-executor-key
ADVISOR_BASE_URL=https://advisor.example.com/v1
ADVISOR_API_KEY=replace-with-advisor-key
```

The `OPENAI_*` pair is passed only to the normal executor gateway, while the
`ADVISOR_*` pair is passed only to the advisor sidecar. The pairs may contain
the same values, but neither pair falls back to the other.

## Tracing

Executor model calls continue through the normal gateway and keep their normal
trajectory spans. Every advisor call emits a separate `advisor.chat` span with:

- `eval.call.role=advisor`;
- advisor input and output messages;
- requested and resolved advisor model;
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and total tokens;
- the selected tool-description and advisor-system-prompt variant names.

This separates advisor usage from executor usage in Phoenix without adding
pricing. The executor `--max-budget` still does not cap the independently
configured advisor endpoint.

## Build and run

The complete command set is in [`README-RUNS.md`](README-RUNS.md). A minimal
run with built-in text is:

```bash
./target/release/eval-containers run swe-bench \
  --task-id astropy__astropy-12907 \
  --agent opencode-advisory \
  --model aws/claude-haiku-4-5 \
  --gateway-image litellm \
  --advisor-model aws/claude-opus-4-8 \
  --advisor-tool-description-variant neutral \
  --local
```

The equivalent Compose stack layers the agent overlay first and benchmark
Compose file second:

```bash
docker compose \
  --project-directory ./containers/benchmarks/swe-bench \
  -f ./containers/agents/opencode-advisory/compose.yaml \
  -f ./containers/benchmarks/swe-bench/compose.yaml \
  up --abort-on-container-exit
```

## Files

- `Dockerfile` — agent image and OpenCode configuration
- `compose.yaml` — advisor sidecar and runner wiring
- `advisory/tools/advisory.ts` — native advisory tool
- `advisory/context/session-context.mjs` — full-session filtering and serialization
- `advisory/tool-descriptions.json` — six built-in descriptions
- `advisory/resolve-config.py` — named executor prompt resolver
- `advisory/service/` — advisor HTTP service, tracing, and tests
- `advisory/system-prompts/` — reusable executor system-prompt files
