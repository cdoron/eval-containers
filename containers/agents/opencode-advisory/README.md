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
executor OpenCode -> intervention router -> executor gateway -> executor model
                         \-> advisory tool -> advisor sidecar -> advisor model
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

## Platform-initiated random calls

The default `self-initiated` policy preserves the original behavior. With
`--advisor-invocation-policy random`, an agent-local router decides before each
eligible executor turn whether the platform should call the advisor instead.
Selected turns do not call the executor model. The following turn is always an
executor turn, so random selection cannot create consecutive advisor-only
turns.

In random mode:

- the router removes the `advisory` definition from the tools sent to the
  executor, so the executor cannot initiate advisor calls;
- executor system-prompt additions are rejected, preventing a stale prompt
  from mentioning the advisor in this condition;
- the synthetic advisory tool call and result are removed from the next
  executor request;
- the advice is sent to the executor as a platform `system` message beginning
  with: `This is not your tool call, but an advisor call initiated by the
  platform. The advisor's response is:`;
- each decision and its call count are written as structured JSON to the agent
  stderr log.

Random mode requires `full-session` context, an explicit probability, and a
deterministic seed. `EVAL_ADVISOR_MAX_CALLS` is optional; omitted or
`unlimited` means no cap. A finite cap counts attempted platform calls,
including failed advisor calls.

OpenJev mode uses the same router and synthetic advisor-call protocol, but
replaces the random draw with an authenticated `/v1/systemone` classification.
The classifier receives a bounded copy of the model-visible executor messages;
its frame, question, criteria, labels, and context bounds are configurable with
`EVAL_ADVISOR_OPENJEV_POLICY_CONFIG`. Classifier errors fail open to a normal
executor turn and do not consume an advisor call. The classifier runs every
`EVAL_ADVISOR_OPENJEV_INTERVAL` eligible turns (default `1`). A selected call
passes the exact compact state evaluated by OpenJev to the advisor and is still
followed by one mandatory executor turn. The call cap is optional and defaults
to unlimited. The default question tells OpenJev that advisor calls are more
expensive and, for a finite budget, limited.

Fixed mode uses the same platform-call protocol without a classifier or random
draw. Configure exactly one of `EVAL_ADVISOR_FIXED_TURN` for one call at turn
Y, or `EVAL_ADVISOR_FIXED_INTERVAL` for calls at turns X, 2X, 3X, and so on.
The optional shared call cap applies to recurring schedules.

## Configurable text

Three independent values can be changed for experiments:

- executor system-prompt addition;
- advisor system prompt;
- advisory tool description.

An optional base-system-prompt replacement is configured separately with
`EVAL_OPENCODE_BASE_SYSTEM_PROMPT`. When non-empty, the runner creates and
selects a native OpenCode V1 `agent.eval-base.prompt`; when empty, OpenCode's
built-in base prompt remains unchanged. This is replacement configuration,
whereas `EVAL_EXECUTOR_SYSTEM_PROMPT` remains the independently appended or
prepended experiment instruction.

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
Set `EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION=prepend` to place the configured
executor addition before OpenCode's built-in prompt; the default is `append`.

## Advisor context

The default `agent-provided` mode keeps the existing tool contract: OpenCode
writes a `request` and `context` argument for each advisory call. Set
`--advisor-context-mode full-session` to make the tool take no arguments and
instead send:

- a fixed, concise review request;
- the configured executor system-prompt addition;
- the model-visible OpenCode conversation in chronological order, including
  exposed reasoning and tool calls, results, and errors, but not executor tool
  definitions.

The serializer applies OpenCode's completed-compaction boundary, uses its
placeholder for cleared old tool results, and removes session bookkeeping such
as IDs, timestamps, snapshots, token accounting, UI diffs, and duplicated tool
metadata. The active advisory call is removed to prevent recursion. Earlier
advisory responses stay in place, but their old request/context inputs are
removed so the complete session is not recursively duplicated. OpenCode does
not expose its built-in base system prompt to custom tools, so only the
configured executor addition can be included.

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
| `EVAL_ADVISOR_TIMEOUT_SECONDS` / `--advisor-timeout-seconds` | Advisor service and tool request timeout; default `300` |
| `EVAL_ADVISOR_INVOCATION_POLICY` / `--advisor-invocation-policy` | `self-initiated`, `random`, `openjev`, or `fixed` |
| `EVAL_ADVISOR_RANDOM_PROBABILITY` / `--advisor-random-probability` | Random selection probability from `0` to `1` |
| `EVAL_ADVISOR_MAX_CALLS` / `--advisor-max-calls` | Optional positive platform-call cap; omitted or `unlimited` means no cap |
| `EVAL_ADVISOR_RANDOM_SEED` / `--advisor-random-seed` | Deterministic experiment seed |
| `OPENJEV_BASE_URL` / `--openjev-base-url` | Authenticated OpenJev helper base URL |
| `OPENJEV_API_KEY` | OpenJev helper bearer token; environment only |
| `EVAL_ADVISOR_OPENJEV_TIMEOUT_SECONDS` / `--advisor-openjev-timeout-seconds` | OpenJev classification timeout; default `30` |
| `EVAL_ADVISOR_OPENJEV_INTERVAL` / `--advisor-openjev-interval` | Classify every N eligible executor turns; default `1` |
| `EVAL_ADVISOR_OPENJEV_POLICY_CONFIG` / `--advisor-openjev-policy-config` | Resolved OpenJev decision-policy JSON |
| `--advisor-openjev-policy-config-file` | Host JSON file resolved into the policy configuration |
| `EVAL_ADVISOR_FIXED_TURN` / `--advisor-fixed-turn` | Make one platform advisor call at eligible executor turn Y |
| `EVAL_ADVISOR_FIXED_INTERVAL` / `--advisor-fixed-interval` | Make a platform advisor call every X eligible executor turns |
| `EVAL_EXECUTOR_MAX_TURNS` / `--executor-max-turns` | Optional eligible executor-turn cap; `0` means unlimited |

For platform-initiated calls, only a successful advisor result is inserted as
the prefixed system message. A timeout or other tool error is removed together
with the synthetic tool call before the executor request is forwarded. The
failed attempt still consumes one call from `EVAL_ADVISOR_MAX_CALLS`.

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
- `advisory/intervention/random-router.mjs` — platform random/OpenJev router
- `advisory/intervention/classifier-context.mjs` — bounded model-visible classifier context
- `advisory/intervention/openjev-policy.mjs` — authenticated OpenJev decision policy
- `advisory/intervention/openjev-policy.example.json` — configurable policy example
- `advisory/intervention/protocol.mjs` — synthetic-call and platform-message contract
- `advisory/tool-descriptions.json` — six built-in descriptions
- `advisory/resolve-config.py` — named executor prompt resolver
- `advisory/service/` — advisor HTTP service, tracing, and tests
- `advisory/system-prompts/` — reusable executor system-prompt files
