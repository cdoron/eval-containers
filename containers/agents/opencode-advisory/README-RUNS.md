# OpenCode Advisory: Build and Run Guide

Run commands from the repository root. Preview commands before any paid run.

## 1. Prepare the shell

```bash
cd /path/to/eval-containers
docker context show
docker info >/dev/null

set -a
source .env
set +a

: "${OPENAI_API_KEY:?missing OPENAI_API_KEY}"
: "${OPENAI_API_BASE:?missing OPENAI_API_BASE}"
: "${ADVISOR_API_KEY:?missing ADVISOR_API_KEY}"
: "${ADVISOR_BASE_URL:?missing ADVISOR_BASE_URL}"

export EVAL_BUILD_PLATFORM=linux/amd64
export SWE_BENCH_TASK_ID=django__django-14011
export EXECUTOR_MODEL=aws/claude-haiku-4-5
export ADVISOR_MODEL=aws/claude-opus-4-8
```

`OPENAI_API_BASE` / `OPENAI_API_KEY` belong to the executor gateway.
`ADVISOR_BASE_URL` / `ADVISOR_API_KEY` belong to the advisor service. They may
point to the same endpoint, but no value is copied or inherited between them.
Keep all four in `.env`; experiment JSON deliberately contains no secrets.

## 2. Rebuild after these changes

Use a new immutable tag for this code. Do not publish it as `latest` and do
not reuse a tag from an earlier experiment.

```bash
cargo build --release --manifest-path cli/Cargo.toml

export IMAGE_TAG=platform-random-v1

TAG="$IMAGE_TAG" \
  ./target/release/eval-containers build agent opencode-advisory \
  --platform "$EVAL_BUILD_PLATFORM"

TAG="$IMAGE_TAG" EVAL_BENCHMARK_TAG=latest EVAL_AGENT_TAG="$IMAGE_TAG" \
  ./target/release/eval-containers build eval swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model litellm \
  --platform "$EVAL_BUILD_PLATFORM"
```

The eval build reads the unchanged task benchmark from `:latest`, reads the
new agent from `:$IMAGE_TAG`, and writes the combined eval to `:$IMAGE_TAG`.
It does not move any existing tag. Rebuild LiteLLM or a benchmark image only
if that component changed.

## 3. Text-source model

Executor system prompt, advisor system prompt, and tool description each accept
one of three sources.

| Value | Inline text | Host text file | Named external entry |
|---|---|---|---|
| Executor system prompt | `--executor-system-prompt` | `--executor-system-prompt-file` | `--executor-system-prompt-variant` |
| Advisor system prompt | `--advisor-system-prompt` | `--advisor-system-prompt-file` | `--advisor-system-prompt-variant` |
| Tool description | `--advisor-tool-description` | `--advisor-tool-description-file` | `--advisor-tool-description-variant` |

The CLI reads host files before launching Compose. This keeps Compose portable
and avoids a new bind mount for each prompt. The equivalent environment values
are `EVAL_EXECUTOR_SYSTEM_PROMPT`, `EVAL_ADVISOR_SYSTEM_PROMPT`, and
`EVAL_ADVISOR_TOOL_DESCRIPTION`.

`EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION` controls where the executor addition is
placed. It defaults to `append`; set it to `prepend` to place the same text
before OpenCode's built-in system prompt.

For named entries, pass a catalog with `--advisory-config-file`:

```json
{
  "executor_system_prompts": {"review-first": "..."},
  "advisor_system_prompts": {"concise": "..."},
  "tool_descriptions": {"reviewer": "..."}
}
```

The CLI reads it into `EVAL_ADVISORY_CONFIG`. You can instead supply inline JSON
with `--advisory-config`. Plain Compose has the same behavior:

```bash
export EVAL_ADVISORY_CONFIG="$(cat experiments/advisory-config.example.json)"
```

Direct text, direct file, and variant are mutually exclusive for each value.
Unknown variants and empty files fail before a model call.

The six tool variants in `advisory/tool-descriptions.json` need no external
catalog: `conservative`, `encouraging`, `mandatory`, `neutral`, `prescriptive`,
and `uncertainty`. `neutral` is the default.

## 4. CLI examples

Inline executor and advisor prompts with free-form tool text:

```bash
./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --executor-system-prompt "Consult the advisor before coding and before finishing." \
  --advisor-system-prompt "Give concise, correctness-focused review." \
  --advisor-tool-description "Ask an independent model to review the current decision and context." \
  --experiment-id inline-prompts \
  --local --timeout 1800
```

Text-file inputs:

```bash
./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --executor-system-prompt-file containers/agents/opencode-advisory/advisory/system-prompts/anthropic-advisory-instructions.txt \
  --advisor-system-prompt-file ./my-advisor-system-prompt.txt \
  --advisor-tool-description-file ./my-tool-description.txt \
  --experiment-id file-prompts \
  --local --timeout 1800
```

Named external entries:

```bash
./target/release/eval-containers run appworld \
  --task-id 6 \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --advisory-config-file experiments/advisory-config.example.json \
  --executor-system-prompt-variant inspect-tools \
  --advisor-system-prompt-variant strategic-default \
  --advisor-tool-description-variant brief-reviewer \
  --experiment-id named-prompts \
  --local --timeout 900
```

Built-in tool description plus default advisor system prompt:

```bash
./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --advisor-context-mode full-session \
  --advisor-full-context-max-bytes 0 \
  --advisor-tool-description-variant prescriptive \
  --local --timeout 1800
```

Platform-initiated random calls, with no executor prompt mentioning the
advisor and no advisory tool definition exposed to the executor:

```bash
./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --advisor-context-mode full-session \
  --advisor-invocation-policy random \
  --advisor-random-probability 0.25 \
  --advisor-max-calls 3 \
  --advisor-random-seed random-v1-repetition-1 \
  --experiment-id random-v1-repetition-1 \
  --agent-tag "$IMAGE_TAG" \
  --local --timeout 1800
```

Do not add any `--executor-system-prompt*` option for this condition. The
platform router supplies the advisor intervention independently of prompting.

Platform-initiated OpenJev classification, preserving the same hidden tool
protocol while allowing either a finite call limit or `unlimited`:

```bash
export OPENJEV_API_KEY="replace-with-helper-token"

./target/release/eval-containers run swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model "$EXECUTOR_MODEL" \
  --gateway-image litellm \
  --advisor-model "$ADVISOR_MODEL" \
  --advisor-base-url "$ADVISOR_BASE_URL" \
  --advisor-context-mode full-session \
  --advisor-invocation-policy openjev \
  --openjev-base-url http://openjev-svc.advisor-erel.svc.cluster.local:3000 \
  --advisor-openjev-policy-config-file \
    containers/agents/opencode-advisory/advisory/intervention/openjev-policy.example.json \
  --advisor-openjev-timeout-seconds 30 \
  --advisor-openjev-interval 1 \
  --advisor-max-calls unlimited \
  --experiment-id openjev-neutral-v1 \
  --agent-tag "$IMAGE_TAG" \
  --local --timeout 1800
```

OpenJev classification failures are logged and fail open to the executor. They
do not consume the advisor-call budget. A selected advisor attempt does consume
the budget even if the downstream advisor later fails, matching random mode.

Platform-initiated fixed scheduling, using either one turn or one interval:

```bash
# One call at eligible executor turn 12:
--advisor-invocation-policy fixed --advisor-fixed-turn 12

# Or calls at turns 10, 20, 30, ... with an optional finite cap:
--advisor-invocation-policy fixed --advisor-fixed-interval 10 --advisor-max-calls 3
```

Both forms also require `--advisor-context-mode full-session`, the immutable
`--agent-tag`, and the normal executor/advisor endpoint options shown above.

## 5. Experiment JSON

The JSON names match the CLI concepts:

```json
{
  "$schema": "./schema.json",
  "benchmark": "swe-bench",
  "task_id": "django__django-14011",
  "agent": "opencode-advisory",
  "executor_model": "aws/claude-haiku-4-5",
  "gateway_image": "litellm",
  "agent_tag": "platform-random-v1",
  "mode": "compose",
  "local": true,
  "experiment_id": "random-v1-repetition-1",
  "advisory_config_file": "experiments/advisory-config.example.json",
  "advisor": {
    "model": "aws/claude-opus-4-8",
    "system_prompt_variant": "strategic-default",
    "context_mode": "full-session",
    "full_context_max_bytes": 0,
    "invocation_policy": "random",
    "random_probability": 0.25,
    "max_calls": 3,
    "random_seed": "random-v1-repetition-1",
    "log_payloads": true
  }
}
```

Supported prompt fields are:

- top-level `agent_tag` selects the immutable agent and combined eval images;
- top level: `executor_system_prompt`, `executor_system_prompt_file`,
  `executor_system_prompt_variant`, `advisory_config`, and
  `advisory_config_file`;
- under `advisor`: `system_prompt`, `system_prompt_file`,
  `system_prompt_variant`, `tool_description`, `tool_description_file`, and
  `tool_description_variant`, plus `context_mode` and
  `full_context_max_bytes`. Platform invocation additionally uses
  `invocation_policy` and optional `max_calls`; random uses
  `random_probability` and `random_seed`; OpenJev uses `openjev_base_url`,
  `openjev_timeout_seconds`, `openjev_interval`, and its policy configuration;
  fixed uses exactly one of `fixed_turn` or `fixed_interval`.

`context_mode` defaults to `agent-provided`. In `full-session`, the advisor
receives a compact model-visible OpenCode conversation, including exposed
reasoning and tool calls/results but excluding executor tool definitions and
internal session bookkeeping. Completed OpenCode compaction boundaries are
honored. The active advisory call is removed; earlier advice remains without
its duplicated old inputs. A nonzero `full_context_max_bytes` fails clearly
when exceeded and never truncates.

Each JSON file describes exactly one experiment. Use a separate file for each
configuration; there is no run array or run index. Secrets remain in the shell,
never the experiment file.

Preview without building or running:

```bash
python3 experiments/run_experiment.py \
  experiments/experiemnt_with_system_prompt_injection.json
```

Run with existing images:

```bash
python3 experiments/run_experiment.py \
  experiments/experiemnt_with_system_prompt_injection.json \
  --execute
```

Add `--build` only when you want the helper to build the required combination
before execution:

```bash
python3 experiments/run_experiment.py \
  experiments/experiemnt_with_system_prompt_injection.json \
  --build --execute
```

Both `--execute` forms can make paid model requests.

## 6. Verify traces and results

Detailed output is written below:

```text
output/<benchmark>/<agent>/<task-id>/
```

The benchmark history is appended to:

```text
output/<benchmark>/results.jsonl
```

In Phoenix, filter advisor calls with `eval.call.role = advisor` or span name
`advisor.chat`. Each advisor span contains:

- `gen_ai.input.messages` and `gen_ai.output.messages`;
- `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`;
- `eval.advisor.description_variant`;
- `eval.advisor.system_prompt_variant`.

Executor calls remain the gateway spans in the same trace. Do not add advisor
and executor token values from the same span twice: `gen_ai.usage.*` and
`llm.token_count.*` can be aliases emitted for one call by an importer.

## 7. What changed

The old `prompt_hint`, `prompt_policy`, and `prompt_policy_target` experiment
fields and their CLI/environment variables were removed. Prompt additions are
now system-context additions only. Existing experiment files must use the new
fields; the examples in `experiments/` have already been migrated.
