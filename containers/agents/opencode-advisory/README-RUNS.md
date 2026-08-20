# OpenCode Advisory: Build and Run Guide

Run these commands from the repository root. Benchmark runs make real model
calls; build and validate first, then run deliberately.

The normal CLI remains fully supported. JSON files are optional templates that
call the same CLI flags sequentially.

## 1. Prepare

```bash
cd /path/to/eval-containers
docker context show                 # expected: colima
docker info >/dev/null

set -a
source .env
set +a

: "${OPENAI_API_KEY:?missing OPENAI_API_KEY}"
: "${OPENAI_API_BASE:?missing OPENAI_API_BASE}"

export EVAL_BUILD_PLATFORM=linux/amd64
export APPWORLD_TASK_ID=6
export SWE_BENCH_TASK_ID=astropy__astropy-12907
export EXECUTOR_MODEL=aws/claude-haiku-4-5
export ADVISOR_MODEL=aws/claude-opus-4-8
export ADVISOR_BASE_URL="$OPENAI_API_BASE"
export ADVISOR_API_KEY="$OPENAI_API_KEY"
```

The executor and advisor models are independent. Secrets stay in the shell or
`.env`; do not put them in experiment JSON.

## 2. Rebuild the CLI and all local images

```bash
cargo build --release --manifest-path cli/Cargo.toml

./target/release/eval-containers build model litellm \
  --platform "$EVAL_BUILD_PLATFORM"

./target/release/eval-containers build agent opencode \
  --platform "$EVAL_BUILD_PLATFORM"
./target/release/eval-containers build agent opencode-advisory \
  --platform "$EVAL_BUILD_PLATFORM"

./target/release/eval-containers build bench appworld \
  --platform "$EVAL_BUILD_PLATFORM"
./target/release/eval-containers build bench swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --platform "$EVAL_BUILD_PLATFORM"

./target/release/eval-containers build eval appworld \
  --agent opencode --model litellm \
  --platform "$EVAL_BUILD_PLATFORM" --no-pull
./target/release/eval-containers build eval appworld \
  --agent opencode-advisory --model litellm \
  --platform "$EVAL_BUILD_PLATFORM" --no-pull
./target/release/eval-containers build eval swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode --model litellm \
  --platform "$EVAL_BUILD_PLATFORM" --no-pull
./target/release/eval-containers build eval swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory --model litellm \
  --platform "$EVAL_BUILD_PLATFORM" --no-pull
```

Why these rebuilds are needed:

- `opencode-advisory` contains the advisor tool, service, descriptions, and
  prompt-policy files.
- AppWorld contains its optional default hint file.
- Every combined eval image contains the generic prompt composer and result
  writer, so rebuild each benchmark-agent combination you will run.
- LiteLLM and regular OpenCode only need rebuilding when their images changed,
  but the commands above intentionally rebuild the complete local matrix.

## 3. Regular command-line runs

Regular OpenCode never loads or starts the advisor sidecar.

```bash
./target/release/eval-containers run appworld \
  --task-id "$APPWORLD_TASK_ID" \
  --agent opencode \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --prompt-hint-mode default \
  --local --timeout 900

./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --prompt-hint-mode none \
  --local --timeout 1800
```

`--prompt-hint-mode default` explicitly loads
`containers/benchmarks/<benchmark>/prompt-hint.txt`. AppWorld ships one. The
mere existence of that file does not enable it. A missing requested default
fails before the agent starts.

Use a custom hint on any benchmark:

```bash
./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --prompt-hint-mode custom \
  --prompt-hint "Check the regression tests before finalizing the patch." \
  --local
```

## 4. Advisory command-line runs

Descriptions are named entries in
`advisory/tool-descriptions.json`: `conservative`, `neutral`, `encouraging`,
`uncertainty`, `prescriptive`, and `mandatory`.

| Description variant | What the executor sees in the advisory tool description |
|---|---|
| `conservative` | Call only when consultation has a high probability of improving the result. |
| `neutral` | Call when consultation is more likely than not to improve the result. This is the default. |
| `encouraging` | Call whenever there is a plausible possibility that consultation will help. |
| `uncertainty` | Call when uncertain, stuck, comparing approaches, or seeking feedback. |
| `prescriptive` | Lists concrete triggers such as stalled attempts, conflicting evidence, material uncertainty, or consequential review. |
| `mandatory` | Strongly says important plans, decisions, and solutions must be reviewed. It does not inject first/last-call instructions unless the prompt policy also requests them. |

The tool description and prompt mandate are separate:

- `--advisor-tool-description-variant mandatory --advisory-prompt-policy none`
  changes only the tool description.
- `--advisory-prompt-policy mandatory-first-last` prepends the explicit first
  and last advisor-call requirement.
- The default prompt policy is `none`; no advisor is mentioned in the task
  prompt merely because `opencode-advisory` is selected.

AppWorld example:

```bash
./target/release/eval-containers run appworld \
  --task-id "$APPWORLD_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --advisor-tool-description-variant neutral \
  --advisory-prompt-policy none \
  --prompt-hint-mode default \
  --experiment-id "appworld-neutral" \
  --local --timeout 900
```

SWE-bench mandatory example:

```bash
./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --advisor-tool-description-variant mandatory \
  --advisory-prompt-policy mandatory-first-last \
  --prompt-hint-mode none \
  --experiment-id "swe-bench-mandatory" \
  --local --timeout 1800
```

For a one-off custom tool description, replace the variant flag with:

```bash
--advisor-tool-description "Consult the advisor whenever a design choice could affect correctness."
```

## 5. Complete parameter reference

### Prompt hints

Hints work with regular and advisory agents on every benchmark because the
generic runner composes them, not the benchmark Compose file.

| CLI | JSON | Environment | Default | Behavior |
|---|---|---|---|---|
| `--prompt-hint-mode none` | `"prompt_hint": {"mode": "none"}` | `EVAL_PROMPT_HINT_MODE=none` | yes | Do not add a hint. A packaged default hint is ignored. |
| `--prompt-hint-mode default` | `"prompt_hint": {"mode": "default"}` | `EVAL_PROMPT_HINT_MODE=default` | no | Prepend `/opt/benchmark/prompt-hint.txt`. Fails before the agent starts if the benchmark has no non-empty default file. |
| `--prompt-hint-mode custom` | `"prompt_hint": {"mode": "custom", "text": "..."}` | `EVAL_PROMPT_HINT_MODE=custom` plus `EVAL_PROMPT_HINT` | no | Prepend the supplied text. Fails if the text is empty. |
| `--prompt-hint <text>` | `prompt_hint.text` | `EVAL_PROMPT_HINT` | unset | Text used only by `custom` mode. It may contain spaces and newlines. |

AppWorld's packaged file is
`containers/benchmarks/appworld/prompt-hint.txt`. Other benchmarks can add a
file at the same relative path. The prompt order is:

1. Selected default or custom hint, if any.
2. Selected advisory prompt policy, if any.
3. The original benchmark prompt.

### Advisor tool and prompt options

These settings are meaningful for `--agent opencode-advisory`. Regular
`opencode` has no advisory tool and does not start the advisor sidecar.

| CLI | JSON | Environment | Default | Behavior |
|---|---|---|---|---|
| `--advisor-tool-description-variant <name>` | `advisor.tool_description_variant` | `ADVISOR_TOOL_DESCRIPTION_VARIANT` | `neutral` | Select one entry from `advisory/tool-descriptions.json`. An unknown name fails rather than falling back silently. |
| `--advisor-tool-description <text>` | `advisor.tool_description` | `ADVISOR_TOOL_DESCRIPTION` | unset | Use custom tool wording. A non-empty custom value overrides the named variant. |
| `--advisory-prompt-policy none` | `advisor.prompt_policy: "none"` | `ADVISORY_PROMPT_POLICY=none` | yes | Do not mention the advisor in the beginning of the task prompt. The tool is still available. |
| `--advisory-prompt-policy mandatory-first-last` | `advisor.prompt_policy: "mandatory-first-last"` | `ADVISORY_PROMPT_POLICY=mandatory-first-last` | no | Require advisory as the first tool call and again as the final tool call before completion. |
| `--advisor-model <model>` | `advisor.model` | `ADVISOR_MODEL` | unset | Model used by the advisor sidecar. This is independent of the executor model. Required for real advisory calls. |
| `--advisor-base-url <url>` | `advisor.base_url` | `ADVISOR_BASE_URL` | required | OpenAI-compatible endpoint used only by the advisor service. It may include `/v1`. |
| `--advisor-log-payloads[=true\|false]` | `advisor.log_payloads` | `ADVISOR_LOG_PAYLOADS` | `false` | Log advisor request/context and returned advice. A bare flag means true. This can expose task content, so enable it deliberately. |
| `--experiment-id <id>` | `experiment_id` | `ADVISORY_EXPERIMENT_ID` | unset | Label attached to advisory requests for later comparison. |

Description precedence is:

1. Non-empty custom `ADVISOR_TOOL_DESCRIPTION` / `advisor.tool_description`.
2. `ADVISOR_TOOL_DESCRIPTION_VARIANT` / `advisor.tool_description_variant`.
3. `neutral`.

Prompt-policy precedence is:

1. Explicit `ADVISORY_PROMPT_POLICY` / `advisor.prompt_policy`.
2. `none`.

Selecting the new `mandatory` description variant does not automatically
enable the mandate. This explicit combination enables both:

```bash
--advisor-tool-description-variant mandatory \
--advisory-prompt-policy mandatory-first-last
```

### Executor and run options

| CLI | JSON | Environment | Default | Purpose |
|---|---|---|---|---|
| global `--registry <ref>` | — | `EVAL_REGISTRY` | `ghcr.io/exgentic` | Registry used for images and published Compose artifacts. Place it before `run` on the command line. |
| positional benchmark or `--benchmark <name>` | `benchmark` | `EVAL_BENCHMARK` | required | Benchmark to run, such as `appworld` or `swe-bench`. |
| `--task-id <id>` | `task_id` | `EVAL_TASK_ID` | `0` | Benchmark task. SWE-bench uses values such as `astropy__astropy-12907`. |
| `--agent <name>` | `agent` | `EVAL_AGENT` | `claude-code` in Compose | `opencode` or `opencode-advisory` for these experiments. |
| `--model <model>` | `executor_model` | `EVAL_MODEL` | required for these runs | Executor model used by OpenCode, independently of `ADVISOR_MODEL`. |
| `--gateway-image <name>` | `gateway_image` | `EVAL_GATEWAY_IMAGE` | `bifrost` | Gateway container, normally `litellm` for these experiments. |
| `--agent-reasoning-effort <level>` | `agent_reasoning_effort` | `EVAL_AGENT_REASONING_EFFORT` | agent default | Optional executor reasoning level when supported. |
| `--timeout <seconds>` | `timeout` | `EVAL_TIMEOUT` | `300` | Agent wall-clock timeout. |
| `--max-budget <usd>` | `max_budget` | `EVAL_MODEL_MAX_BUDGET` | `1` | Executor-model spend cap in USD. This does not currently cap the separately configured advisor endpoint. |
| `--mode compose` | `mode: "compose"` | — | `compose` | Required for `opencode-advisory` because its service is an agent-owned Compose sidecar. |
| `--mode container` | `mode: "container"` | — | no | Single-container runtime. Not currently valid for `opencode-advisory`. |
| `--mode job` | `mode: "job"` | — | no | Kubernetes Job runtime. Not currently valid for `opencode-advisory`. |
| `--local` | `local: true` | — | JSON templates: `true`; CLI: `false` | Use local repository Compose artifacts and images. |
| `--dry-run` | — | — | false | Render configuration without starting an evaluation. |
| `--namespace <name>` | — | — | current Kubernetes namespace | Namespace for `job` mode only. |
| `--overlay <values.yaml>` | — | — | unset | Additional Helm values file for `job` mode only. |
| `--benchmark-tag <tag>` | — | `EVAL_BENCHMARK_TAG` | `latest` | Benchmark image tag. CLI-only in the current matrix format. |
| `--agent-tag <tag>` | — | `EVAL_AGENT_TAG` | `latest` | Agent/eval image tag. CLI-only in the current matrix format. |
| `--model-tag <tag>` | — | `EVAL_MODEL_TAG` | `latest` | Gateway image tag. CLI-only in the current matrix format. |

The generic CLI also exposes `container` and Kubernetes `job` modes,
`--namespace`, and `--overlay`. The advisor sidecar overlay currently exists
only for Compose, so the JSON validator rejects other modes for
`opencode-advisory` instead of starting a broken run.

### Environment-only service options and secrets

Keep credentials in `.env` or the invoking shell. They are intentionally not
accepted in experiment JSON and are not written into per-run `config.json`.
`ADVISOR_BASE_URL` is also omitted from generated `config.json` because a URL
can contain embedded credentials.

| Environment variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | required by gateway | Executor gateway credential. |
| `OPENAI_API_BASE` | provider default/configuration | Executor gateway upstream endpoint. |
| `ADVISOR_API_KEY` | `none` | Advisor endpoint credential. Usually set from `OPENAI_API_KEY` when both models use the same LiteLLM endpoint. |
| `ADVISORY_GATEWAY_URL` | `http://advisor:8001` | Internal URL used by the OpenCode tool to reach the sidecar. Normally do not change it. |
| `ADVISOR_SERVICE_HOST` | `0.0.0.0` | Advisor HTTP service bind address. |
| `ADVISOR_SERVICE_PORT` | `8001` | Advisor HTTP service port. |

## 6. JSON experiment templates

Included templates:

- `experiments/appworld.example.json` — three advisory policies.
- `experiments/swebench.example.json` — three SWE-bench advisory policies.
- `experiments/comparison.example.json` — regular versus advisory OpenCode.
- `experiments/one-experiment.example.json` — one ready-to-edit AppWorld advisory run.
- `experiments/swebench-mandatory-with-hint.json` — one mandatory SWE-bench run with an explicit advisory hint.
- `experiments/schema.json` — editor/schema documentation.

Every JSON document contains optional shared `defaults` and a required,
non-empty `runs` array. Each run is deep-merged over `defaults`; nested
`prompt_hint` and `advisor` objects inherit individual fields.

All supported JSON fields are listed below. Fields marked required may be
supplied by either `defaults` or the individual run.

| JSON field | Type/default | Meaning |
|---|---|---|
| `$schema` | string; optional | Editor/schema reference, normally `./schema.json`. |
| `defaults` | object; optional | Shared values deep-merged into every run. |
| `runs` | non-empty array; required | Sequential experiment configurations. |
| `benchmark` | string; required | Benchmark name. |
| `task_id` | string or integer; required | Task to run. |
| `agent` | string; required | Executor agent. |
| `executor_model` | string; required | Executor model passed to `--model`. |
| `gateway_image` | string; `litellm` in examples | Gateway image passed to `--gateway-image` and used for optional builds. |
| `platform` | string; `linux/amd64` | Platform used by the optional build phase. |
| `mode` | `compose`, `container`, or `job`; `compose` | Deployment mode. Advisory matrices require `compose`. |
| `local` | boolean; `true` | Add `--local` when true. |
| `timeout` | positive integer; unset | Agent timeout seconds. |
| `max_budget` | non-negative number; unset | Executor spend cap. |
| `agent_reasoning_effort` | string; unset | Executor reasoning level. |
| `experiment_id` | string; unset | Optional experiment label attached to advisor requests and saved in `config.json`. |
| `prompt_hint.mode` | `none`, `default`, or `custom`; `none` | Hint selection. |
| `prompt_hint.text` | string; unset | Required when hint mode is `custom`. |
| `advisor.model` | string; unset | Advisor model. |
| `advisor.base_url` | string; inherited environment if omitted | Advisor OpenAI-compatible endpoint. |
| `advisor.tool_description_variant` | string; `neutral` at runtime | Named description variant. |
| `advisor.tool_description` | string; unset | Custom description override. |
| `advisor.prompt_policy` | `none` or `mandatory-first-last`; `none` | Independent task-prompt policy. |
| `advisor.log_payloads` | boolean; `false` | Enable advisor payload logging. |

A minimal regular-agent JSON run is:

```json
{
  "runs": [
    {
      "experiment_id": "regular-appworld",
      "benchmark": "appworld",
      "task_id": "6",
      "agent": "opencode",
      "executor_model": "aws/claude-haiku-4-5",
      "gateway_image": "litellm",
      "prompt_hint": {"mode": "default"}
    }
  ]
}
```

A complete advisory JSON run is:

```json
{
  "runs": [
    {
      "benchmark": "appworld",
      "task_id": "6",
      "agent": "opencode-advisory",
      "executor_model": "aws/claude-haiku-4-5",
      "gateway_image": "litellm",
      "platform": "linux/amd64",
      "mode": "compose",
      "local": true,
      "timeout": 900,
      "max_budget": 1,
      "experiment_id": "appworld-mandatory-custom-hint",
      "prompt_hint": {
        "mode": "custom",
        "text": "Pass the requested answer to complete_task(answer=<answer>)."
      },
      "advisor": {
        "model": "aws/claude-opus-4-8",
        "base_url": "https://litellm.example.com/v1",
        "tool_description_variant": "mandatory",
        "prompt_policy": "mandatory-first-last",
        "log_payloads": false
      }
    }
  ]
}
```

Do not put `ADVISOR_API_KEY`, `OPENAI_API_KEY`, or other secrets in this JSON.

The matrix validator fails before executing commands when:

- `benchmark`, `task_id`, `agent`, or `executor_model` is missing;
- hint mode is not `none`, `default`, or `custom`;
- custom hint mode has no non-empty `prompt_hint.text`;
- prompt policy is not `none` or `mandatory-first-last`;
- an `advisor` object is attached to a non-advisory agent; or
- `opencode-advisory` is configured with a mode other than `compose`.

Preview the fully resolved configurations and commands without building or
running anything:

```bash
python3 experiments/run_matrix.py experiments/one-experiment.example.json
python3 experiments/run_matrix.py experiments/appworld.example.json
```

Run the one-experiment example with existing images, or build its images first:

```bash
python3 experiments/run_matrix.py experiments/one-experiment.example.json --execute

python3 experiments/run_matrix.py experiments/one-experiment.example.json \
  --build --execute
```

Both commands with `--execute` start a real evaluation and can make paid model
requests. Edit the example's task, models, hint, and advisor settings first.

Build each unique gateway, agent, benchmark, and eval combination once, then
run every configuration sequentially:

```bash
python3 experiments/run_matrix.py experiments/appworld.example.json \
  --build --execute

python3 experiments/run_matrix.py experiments/swebench.example.json \
  --build --execute
```

Omit `--build` when the images already exist. The runner stops at the first
failed command by default; add `--continue-on-failure` only when that is what
you want. API keys are inherited from the environment and are never read from
or written to the JSON file.

Matrix-runner options:

| Option | Default | Behavior |
|---|---|---|
| no option | preview | Validate, print resolved runs, and print commands without executing them. |
| `--execute` | off | Actually execute the printed run commands. |
| `--build` | off | Include one build of each unique gateway, agent, benchmark/task image, and eval combination. It executes only when combined with `--execute`. |
| `--continue-on-failure` | off | Continue to later runs after a failed command; otherwise stop immediately. |
| `--cli <path>` | `target/release/eval-containers` | Use a different CLI binary. |

## 7. Results

Each benchmark/agent/task combination has one detailed result directory:

```text
output/<benchmark>/<agent>/<task-id>/
  config.json
  traces.jsonl
  agent/
  model/
  task/
```

Repeating the same benchmark, agent, and task replaces that detailed directory.
After each run, the CLI appends its result and secret-free configuration to:

```text
output/<benchmark>/results.jsonl
```

Inspect all results or the current detailed task output:

```bash
./target/release/eval-containers report output
jq -s . output/appworld/results.jsonl

task_output="output/appworld/opencode-advisory/$APPWORLD_TASK_ID"
jq . "$task_output/config.json" "$task_output/task/result.json"
rg -n "advisory|complete_task" "$task_output"
```

A successful Docker/Compose exit is not enough: check `task/result.json`, the
agent exit code, and that `traces.jsonl` contains real model spans.
