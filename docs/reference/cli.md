# CLI reference

*Reference · for operators & contributors · derives from `cli/src/` (`main.rs`, `run.rs`, `build.rs`) and [`.agents/src/RULES.md`](../../.agents/src/RULES.md). The source is authoritative; run `eval-containers --help` for the exact, current flags.*

The `eval-containers` CLI is optional — every command maps to a plain
`docker` / `helm` / `kubectl` / `oc` command you could type yourself. State- or
outward-changing commands support `--dry-run` to print that command without
running it.

## Global

```
eval-containers [--registry <ref>] <command> [args]
```

| Flag | Env | Default |
|---|---|---|
| `--registry <ref>` | `EVAL_REGISTRY` | `ghcr.io/exgentic` |

## Commands

| Command | Does | Wraps |
|---|---|---|
| `run` | Run an evaluation | `docker compose` / `docker run` / `helm template \| kubectl apply` |
| `build` | Build images (agents, benchmarks, models, eval combos) | `docker buildx bake` / `docker build` |
| `push` | Push images to the registry | `docker push` |
| `list` | List images with metadata | reads the repo |
| `images` | Show images with sizes | `docker images` |
| `inspect` | Inspect an image | `docker inspect` |
| `prune` | Reclaim disk | `docker builder prune` + `docker image prune` |
| `report` | Aggregate results: pass/reward/tokens/cost + traces health | reads `output/` |
| `gen-bake` | Scaffold a `docker-bake.hcl` for an artifact | writes a file |
| `oracle` | Validate a benchmark's grading: a gold solution must score 1.0 and a no-op < 1.0 through the benchmark's own grader (no agent, no model). See [Oracle](../../containers/core/oracle/README.md). | `docker run` against the grader |

## `run` flags

`eval-containers run [BENCHMARK] [flags]` — `BENCHMARK` is a positional
shortcut for `--benchmark`. Every `EVAL_*` axis has a matching flag; the flag
overrides the env var.

| Flag | Maps to | Notes |
|---|---|---|
| `--benchmark <name>` | `EVAL_BENCHMARK` | or positional |
| `--agent <name>` | `EVAL_AGENT` | |
| `--model <name>` | `EVAL_MODEL` | sets the gateway upstream |
| `--agent-reasoning-effort <level>` | `EVAL_AGENT_REASONING_EFFORT` | the agent applies it; e.g. `high` |
| `--task-id <id>` | `EVAL_TASK_ID` | default `0` |
| `--gateway-image <name>` | `EVAL_GATEWAY_IMAGE` | e.g. `litellm` or `bifrost` |
| `--executor-system-prompt <text>` | `EVAL_EXECUTOR_SYSTEM_PROMPT` | OpenCode system-context addition |
| `--executor-system-prompt-file <path>` | reads into `EVAL_EXECUTOR_SYSTEM_PROMPT` | host text file |
| `--executor-system-prompt-variant <name>` | `EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT` | named external entry |
| `--advisory-config <json>` | `EVAL_ADVISORY_CONFIG` | inline named catalog |
| `--advisory-config-file <path>` | reads into `EVAL_ADVISORY_CONFIG` | host JSON file |
| `--advisor-tool-description-variant <name>` | `EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT` | built-in or external named entry |
| `--advisor-tool-description <text>` | `EVAL_ADVISOR_TOOL_DESCRIPTION` | free-form wording |
| `--advisor-tool-description-file <path>` | reads into `EVAL_ADVISOR_TOOL_DESCRIPTION` | host text file |
| `--advisor-system-prompt <text>` | `EVAL_ADVISOR_SYSTEM_PROMPT` | free-form advisor prompt |
| `--advisor-system-prompt-file <path>` | reads into `EVAL_ADVISOR_SYSTEM_PROMPT` | host text file |
| `--advisor-system-prompt-variant <name>` | `EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT` | named external entry |
| `--advisor-model <model>` | `ADVISOR_MODEL` | independent advisor model |
| `--advisor-base-url <url>` | `ADVISOR_BASE_URL` | credential stays in `ADVISOR_API_KEY` env |
| `--advisor-log-payloads[=true\|false]` | `ADVISOR_LOG_PAYLOADS` | off by default; bare flag means true |
| `--advisor-context-mode <agent-provided\|full-session>` | `EVAL_ADVISOR_CONTEXT_MODE` | full-session exports the active OpenCode conversation |
| `--advisor-full-context-max-bytes <bytes>` | `EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES` | `0` is unlimited; nonzero overflow fails without truncating |
| `--advisor-timeout-seconds <seconds>` | `EVAL_ADVISOR_TIMEOUT_SECONDS` | per advisor attempt |
| `--advisor-transient-retries <count>` | `EVAL_ADVISOR_TRANSIENT_RETRIES` | transient advisor and decision-model retries |
| `--advisor-retry-delay-seconds <seconds>` | `EVAL_ADVISOR_RETRY_DELAY_SECONDS` | delay between transient retries |
| `--advisor-invocation-policy <policy>` | `EVAL_ADVISOR_INVOCATION_POLICY` | self-initiated, random, openjev, sii-decision, or fixed |
| `--advisor-random-probability <probability>` | `EVAL_ADVISOR_RANDOM_PROBABILITY` | random selection probability from 0 to 1 |
| `--advisor-max-calls <count\|unlimited>` | `EVAL_ADVISOR_MAX_CALLS` | optional platform-call cap |
| `--advisor-random-seed <seed>` | `EVAL_ADVISOR_RANDOM_SEED` | deterministic random-policy seed |
| `--openjev-base-url <url>` | `OPENJEV_BASE_URL` | credential stays in `OPENJEV_API_KEY` env |
| `--advisor-openjev-timeout-seconds <seconds>` | `EVAL_ADVISOR_OPENJEV_TIMEOUT_SECONDS` | decision request timeout |
| `--advisor-openjev-interval <turns>` | `EVAL_ADVISOR_OPENJEV_INTERVAL` | query every N eligible turns |
| `--advisor-openjev-policy-config <json>` | `EVAL_ADVISOR_OPENJEV_POLICY_CONFIG` | inline schema-versioned policy |
| `--advisor-openjev-policy-config-file <path>` | reads into `EVAL_ADVISOR_OPENJEV_POLICY_CONFIG` | host JSON file |
| `--sii-decision-base-url <url>` | `SII_DECISION_BASE_URL` | credential stays in `SII_DECISION_API_KEY` env |
| `--advisor-sii-decision-timeout-seconds <seconds>` | `EVAL_ADVISOR_SII_DECISION_TIMEOUT_SECONDS` | decision request timeout |
| `--advisor-sii-decision-interval <turns>` | `EVAL_ADVISOR_SII_DECISION_INTERVAL` | query every N eligible turns |
| `--advisor-sii-decision-logprobs <count>` | `EVAL_ADVISOR_SII_DECISION_LOGPROBS` | top completion-token probabilities, 2 to 256 |
| `--advisor-sii-decision-policy-config <json>` | `EVAL_ADVISOR_SII_DECISION_POLICY_CONFIG` | inline schema-versioned policy |
| `--advisor-sii-decision-policy-config-file <path>` | reads into `EVAL_ADVISOR_SII_DECISION_POLICY_CONFIG` | host JSON file |
| `--advisor-fixed-turn <turn>` | `EVAL_ADVISOR_FIXED_TURN` | one call at an eligible turn |
| `--advisor-fixed-interval <turns>` | `EVAL_ADVISOR_FIXED_INTERVAL` | recurring eligible-turn schedule |
| `--executor-max-turns <turns>` | `EVAL_EXECUTOR_MAX_TURNS` | `0` means unlimited |
| `--experiment-id <id>` | `ADVISORY_EXPERIMENT_ID` | trace/experiment label |
| `--mode <compose\|container\|job>` | — | default `compose` |
| `--benchmark-tag <tag>` | `EVAL_BENCHMARK_TAG` | image tag |
| `--agent-tag <tag>` | `EVAL_AGENT_TAG` | image tag |
| `--model-tag <tag>` | `EVAL_MODEL_TAG` | image tag |
| `--benchmark-version <v>` | `EVAL_BENCHMARK_VERSION` | dataset revision inside the image |
| `--agent-version <v>` | `EVAL_AGENT_VERSION` | upstream CLI version inside the image |
| `--litellm-version <v>` | `EVAL_LITELLM_VERSION` | LiteLLM version inside the image |
| `--timeout <secs>` | `EVAL_TIMEOUT` | default `300` |
| `--max-budget <usd>` | `EVAL_MODEL_MAX_BUDGET` | hard spend cap; default `$1` |
| `--local` | — | use in-repo `containers/benchmarks/<name>/` instead of the registry |
| `--dry-run` | — | print/validate without deploying (`job`: `kubectl --dry-run=server`) |
| `-n, --namespace <ns>` | — | `job` mode only; `kubectl -n` |
| `--overlay <values.yaml>` | — | `job` mode only; extra `helm -f` (e.g. `deploy/values-openshift.yaml`) |

See [Environment variables](env-vars.md) for the full `EVAL_*` namespace.

Single-experiment JSON files are an additional convenience, not a replacement
for these flags. Preview with
`python3 experiments/run_experiment.py <config.json>` and add
`--build --execute` to build the required combination and run it.

## `build` flags

`eval-containers build <agent|bench|model|eval> <name> [flags]`

`eval-containers build compose --benchmark <x>` publishes that benchmark's
compose stack to `oci://<registry>/eval-<x>` — the benchmark's `compose.yaml`
flattened (shared `services.yaml` resolved in via its `include:`, plus the
benchmark's sidecars) so `run --mode compose` consumes it with a single `-f`.
The runner image and env stay parameterized at run time by `EVAL_AGENT` /
`EVAL_TASK_ID`. Run once per benchmark (the release CI does this in a loop).

| Flag | Notes |
|---|---|
| `--benchmark <x>` | `build compose` only — which benchmark's stack to publish (required there) |
| `--builder <name>` | build with a named buildx builder (e.g. in-cluster `--driver kubernetes`); **implies `--push`** |
| `--dry-run` | print the underlying command(s) without running them (`build compose`: the `docker compose config` + `publish` pair; image builds: the `docker buildx bake` line) |

If the named builder doesn't exist, the command fails with the exact
`docker buildx create` line to run.
