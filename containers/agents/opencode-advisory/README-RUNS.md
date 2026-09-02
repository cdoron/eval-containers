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

```bash
cargo build --release --manifest-path cli/Cargo.toml

./target/release/eval-containers build agent opencode-advisory \
  --platform "$EVAL_BUILD_PLATFORM"

./target/release/eval-containers build bench swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --platform "$EVAL_BUILD_PLATFORM"

./target/release/eval-containers build eval swe-bench \
  --task-id "$SWE_BENCH_TASK_ID" \
  --agent opencode-advisory \
  --model litellm \
  --platform "$EVAL_BUILD_PLATFORM" \
  --no-pull
```

Rebuild LiteLLM only if its image changed. Rebuild other benchmark/task
combinations only when you intend to run them.

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
  "mode": "compose",
  "local": true,
  "experiment_id": "named-configuration",
  "advisory_config_file": "experiments/advisory-config.example.json",
  "executor_system_prompt_variant": "inspect-tools",
  "advisor": {
    "model": "aws/claude-opus-4-8",
    "system_prompt_variant": "strategic-default",
    "tool_description_variant": "brief-reviewer",
    "context_mode": "full-session",
    "full_context_max_bytes": 0,
    "log_payloads": true
  }
}
```

Supported prompt fields are:

- top level: `executor_system_prompt`, `executor_system_prompt_file`,
  `executor_system_prompt_variant`, `advisory_config`, and
  `advisory_config_file`;
- under `advisor`: `system_prompt`, `system_prompt_file`,
  `system_prompt_variant`, `tool_description`, `tool_description_file`, and
  `tool_description_variant`, plus `context_mode` and
  `full_context_max_bytes`.

`context_mode` defaults to `agent-provided`. In `full-session`, the advisor
receives the original task and the exported OpenCode conversation, including
exposed reasoning and tool calls/results. The active advisory call is removed;
earlier advice remains without its duplicated old inputs. A nonzero
`full_context_max_bytes` fails clearly when exceeded and never truncates.

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
