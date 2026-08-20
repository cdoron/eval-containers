# opencode-advisory

SST opencode with a native `advisory` tool and an agent-owned HTTP service for
calling a separately configured advisor model.

## At a glance

| Field | Value |
|-------|-------|
| Upstream | [sst/opencode](https://github.com/sst/opencode) |
| Version | `1.4.3` |
| Install mechanism | npm (`opencode-ai` + `@opencode-ai/plugin`) |
| Language runtime | Node.js 22 |

## What it does

Same base as [`opencode`](../opencode/README.md), plus one addition: an
`advisory` tool the model can call to consult a separate advisor model about
its plan or its final answer before submitting.

The complete runtime flow is:

```text
OpenCode advisory tool -> advisor sidecar -> LiteLLM -> advisor model
```

The sidecar runs from this same agent image with a different entrypoint. The
agent-owned [`compose.yaml`](compose.yaml) overlay starts and health-gates it
automatically whenever Compose mode selects `opencode-advisory`; no service
from another repository needs to be running on the host.

The agent-owned sidecar overlay is currently a Compose-mode feature. The JSON
matrix validator therefore rejects `opencode-advisory` entries using container
or Kubernetes job mode instead of pretending the advisor service will exist.

## How the advisory tool works

`advisory` is a native opencode custom tool
([`advisory/tools/advisory.ts`](advisory/tools/advisory.ts)), not a shell
command. opencode itself executes it via `fetch()` against
`$ADVISORY_GATEWAY_URL/advisory`, so the call never depends on whatever
execution channel a benchmark exposes to the model — it works the same
whether the benchmark gives the model a real shell (SWE-bench) or a
sandboxed code-execution bridge with no shell at all (AppWorld).

At container start, `run.sh` copies `advisory.ts` into
`$HOME/.config/opencode/tools/` and symlinks a `node_modules` there pointing
at the global npm install — opencode's actual runtime is a separate
Bun-compiled binary that resolves imports by walking `node_modules` upward
from the importing file, not via `NODE_PATH`.

Tool wording and task-prompt policy are independent. By default the benchmark
prompt does not mention the advisor. Set `ADVISORY_PROMPT_POLICY=mandatory-first-last`
only when the task prompt should explicitly require first and last advisory
calls.

## Description variants

The tool's description (its docstring, as seen by the model) is loaded at
call time from [`advisory/tool-descriptions.json`](advisory/tool-descriptions.json), selected by
`ADVISOR_TOOL_DESCRIPTION_VARIANT` (default `neutral`): `conservative`,
`encouraging`, `mandatory`, `neutral`, `prescriptive`,
`uncertainty`. Each represents a separately selectable experiment condition.

## Configuration

Executor-agent configuration is passed only to OpenCode:

| Var | Default | Purpose |
|-----|---------|---------|
| `ADVISORY_GATEWAY_URL` | `http://advisor:8001` | Base URL of the advisor sidecar |
| `ADVISOR_TOOL_DESCRIPTION_VARIANT` | `neutral` | Which JSON description to load |
| `ADVISOR_TOOL_DESCRIPTION` | unset | Custom description; overrides the named variant |
| `ADVISORY_PROMPT_POLICY` | `none` | `none` or `mandatory-first-last` task-prompt injection |
| `ADVISORY_EXPERIMENT_ID` | unset | Forwarded to the advisor for experiment tagging |

Advisor-service configuration is passed only to the sidecar:

| Var | Default | Purpose |
|-----|---------|---------|
| `ADVISOR_BASE_URL` | required | OpenAI-compatible LiteLLM base URL, with or without `/v1` |
| `ADVISOR_API_KEY` | `none` | Advisor endpoint credential, supplied only at runtime |
| `ADVISOR_MODEL` | unset | Model used for advisory calls; required before `/advisory` can call the model |
| `ADVISOR_SERVICE_HOST` | `0.0.0.0` | HTTP bind address |
| `ADVISOR_SERVICE_PORT` | `8001` | HTTP bind port |
| `ADVISOR_LOG_PAYLOADS` | `false` | Log advisory request/context and returned advice |

See [`advisory/service/.env.example`](advisory/service/.env.example) for safe
placeholders. Do not put credentials in the image or commit a real `.env`.

The executor model still uses the normal eval-containers gateway. The advisor
service uses `ADVISOR_BASE_URL` and `ADVISOR_MODEL`, so the two models remain
independently configurable.

## Build and run

For the complete local rebuild matrix—LiteLLM, regular OpenCode,
`opencode-advisory`, SWE-bench, AppWorld, all four combined images, and every
advisory variant—follow [`README-RUNS.md`](README-RUNS.md).

Build the agent artifact:

```bash
./target/release/eval-containers build agent opencode-advisory
```

The CLI layers this agent's Compose overlay before whichever benchmark Compose
file is selected. The combined eval runner launches `/run.sh`, while the
`advisor` sidecar uses the same agent image with the entrypoint overridden to
`/opt/agent/advisory/service/start.sh`. Compose waits for `/health` before
starting the runner. Regular agents do not load the overlay and therefore do
not start the advisor service.

To exercise the sidecar without an evaluation, start the image with safe test
configuration and then inspect its health endpoint:

```bash
docker run --rm -d --name opencode-advisor-health -p 8001:8001 \
  -e ADVISOR_MODEL=test-advisor-model \
  -e ADVISOR_BASE_URL=http://127.0.0.1:9000 \
  --entrypoint /opt/agent/advisory/service/start.sh \
  ghcr.io/exgentic/agents/opencode-advisory:latest
curl -fsS http://127.0.0.1:8001/health
docker stop opencode-advisor-health
```

The health request does not call the model. A real advisory evaluation needs
`ADVISOR_BASE_URL`, `ADVISOR_API_KEY`, and `ADVISOR_MODEL` in the invoking
environment or Compose `.env`:

```bash
ADVISOR_BASE_URL=https://litellm.example.com/v1 \
ADVISOR_API_KEY="$ADVISOR_API_KEY" \
ADVISOR_MODEL=provider/advisor-model \
./target/release/eval-containers run swe-bench \
  --task-id astropy__astropy-12907 \
  --agent opencode-advisory \
  --model provider/executor-model \
  --advisor-model provider/advisor-model \
  --advisor-tool-description-variant neutral \
  --advisory-prompt-policy none \
  --local
```

The equivalent plain Compose command layers the agent file first and the
benchmark file second:

```bash
docker compose \
  --project-directory ./containers/benchmarks/swe-bench \
  -f ./containers/agents/opencode-advisory/compose.yaml \
  -f ./containers/benchmarks/swe-bench/compose.yaml \
  up --abort-on-container-exit
```

## Optional benchmark hints

AppWorld tasks are graded by the argument passed to
`apis.supervisor.complete_task()`; calling it with the wrong keyword (or no
argument, on an answer-seeking task) silently records nothing. That
clarification is stored in AppWorld's `prompt-hint.txt`. It is off by default
for every agent. Select it explicitly with `--prompt-hint-mode default`, or use
`--prompt-hint-mode custom --prompt-hint "..."` on any benchmark.

## Files

- `Dockerfile` — builds the agent image
- `compose.yaml` — agent-owned advisor sidecar and runner wiring
- `advisory/tools/advisory.ts` — the native opencode tool
- `advisory/tool-descriptions.json` — the named description variants
- `advisory/prompt-policies/` — opt-in prompt-policy text
- `advisory/service/` — the FastAPI advisor service, startup script, config example, and tests
- `README.md` — this file
