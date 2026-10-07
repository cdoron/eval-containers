#!/usr/bin/env python3
"""Preview or execute one evaluation configuration from JSON."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLI = ROOT / "target" / "release" / "eval-containers"


def fail(message: str) -> None:
    raise ValueError(message)


def validate(run: dict[str, Any]) -> None:
    for key in ("benchmark", "task_id", "agent", "executor_model"):
        if not isinstance(run.get(key), (str, int)) or str(run[key]).strip() == "":
            fail(f"configuration.{key} is required")
    validate_source(
        run,
        "executor system prompt",
        (
            "executor_system_prompt",
            "executor_system_prompt_file",
            "executor_system_prompt_variant",
        ),
    )
    validate_source(
        run,
        "advisory configuration",
        ("advisory_config", "advisory_config_file"),
    )
    advisor = run.get("advisor", {})
    validate_source(
        advisor,
        "advisor tool description",
        (
            "tool_description",
            "tool_description_file",
            "tool_description_variant",
        ),
    )
    validate_source(
        advisor,
        "advisor system prompt",
        ("system_prompt", "system_prompt_file", "system_prompt_variant"),
    )
    validate_source(
        advisor,
        "OpenJev policy configuration",
        ("openjev_policy_config", "openjev_policy_config_file"),
    )
    catalog_document: dict[str, Any] | None = None
    for values, keys in (
        (run, ("executor_system_prompt_file", "advisory_config_file")),
        (
            advisor,
            (
                "tool_description_file",
                "system_prompt_file",
                "openjev_policy_config_file",
            ),
        ),
    ):
        for key in keys:
            if values.get(key):
                path = Path(values[key])
                path = path if path.is_absolute() else ROOT / path
                try:
                    text = path.read_text(encoding="utf-8")
                except OSError as error:
                    fail(f"configuration.{key} cannot be read: {error}")
                if not text.strip():
                    fail(f"configuration.{key} is empty")
                if key == "advisory_config_file":
                    catalog_document = json.loads(text)
                    validate_catalog(catalog_document)
                if key == "openjev_policy_config_file":
                    validate_openjev_policy_config(json.loads(text))
    if run.get("advisory_config") is not None:
        catalog_document = run["advisory_config"]
        if isinstance(catalog_document, str):
            catalog_document = json.loads(catalog_document)
        validate_catalog(catalog_document)
    for variant, section, label in (
        (
            run.get("executor_system_prompt_variant"),
            "executor_system_prompts",
            "executor system prompt",
        ),
        (
            advisor.get("system_prompt_variant"),
            "advisor_system_prompts",
            "advisor system prompt",
        ),
    ):
        if variant and (
            catalog_document is None
            or variant not in catalog_document.get(section, {})
        ):
            fail(f"configuration has unknown {label} variant: {variant}")
    tool_variant = advisor.get("tool_description_variant")
    built_in_tools = {
        "conservative", "encouraging", "mandatory", "neutral", "prescriptive", "uncertainty"
    }
    if tool_variant and tool_variant not in built_in_tools and (
        catalog_document is None
        or tool_variant not in catalog_document.get("tool_descriptions", {})
    ):
        fail(
            "configuration has unknown advisor tool description variant: "
            f"{tool_variant}"
        )
    context_mode = advisor.get("context_mode", "agent-provided")
    if context_mode not in {"agent-provided", "full-session"}:
        fail("configuration advisor.context_mode must be agent-provided or full-session")
    max_bytes = advisor.get("full_context_max_bytes", 0)
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 0:
        fail(
            "configuration advisor.full_context_max_bytes must be a "
            "non-negative integer"
        )
    executor_max_turns = run.get("executor_max_turns", 0)
    if (
        isinstance(executor_max_turns, bool)
        or not isinstance(executor_max_turns, int)
        or executor_max_turns < 0
    ):
        fail("configuration executor_max_turns must be a non-negative integer")
    for field in ("timeout_seconds", "openjev_timeout_seconds"):
        value = advisor.get(field)
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 1 <= value <= 86400
        ):
            fail(f"configuration advisor.{field} must be an integer from 1 to 86400")
    invocation_policy = advisor.get("invocation_policy", "self-initiated")
    if invocation_policy not in {"self-initiated", "random", "openjev", "fixed"}:
        fail(
            "configuration advisor.invocation_policy must be "
            "self-initiated, random, openjev, or fixed"
        )
    random_fields = (
        "random_probability",
        "random_seed",
    )
    openjev_fields = (
        "openjev_base_url",
        "openjev_timeout_seconds",
        "openjev_interval",
        "openjev_policy_config",
        "openjev_policy_config_file",
    )
    fixed_fields = ("fixed_turn", "fixed_interval")
    platform_fields = random_fields + openjev_fields + fixed_fields + ("max_calls",)
    if invocation_policy == "self-initiated" and any(field in advisor for field in platform_fields):
        fail(
            "configuration platform advisor fields require invocation_policy "
            "random, openjev, or fixed"
        )
    if invocation_policy != "self-initiated":
        agent_tag = run.get("agent_tag")
        if not isinstance(agent_tag, str) or not agent_tag.strip() or agent_tag == "latest":
            fail(
                "configuration platform advisor invocation requires a "
                "non-latest agent_tag"
            )
        if any(
            run.get(field) not in (None, "")
            for field in (
                "executor_system_prompt",
                "executor_system_prompt_file",
                "executor_system_prompt_variant",
            )
        ):
            fail(
                "configuration platform advisor invocation does not accept an "
                "executor system-prompt addition"
            )
        if context_mode != "full-session":
            fail(
                "configuration platform advisor invocation requires "
                "advisor.context_mode=full-session"
            )
        max_calls = advisor.get("max_calls")
        if max_calls is not None and max_calls != "unlimited" and (
            isinstance(max_calls, bool)
            or not isinstance(max_calls, int)
            or max_calls <= 0
        ):
            fail(
                "configuration advisor.max_calls must be a positive integer, "
                "'unlimited', or omitted"
            )
    if invocation_policy == "random":
        if any(field in advisor for field in openjev_fields + fixed_fields):
            fail("configuration OpenJev/fixed fields do not apply to random policy")
        probability = advisor.get("random_probability")
        if (
            isinstance(probability, bool)
            or not isinstance(probability, (int, float))
            or not 0 <= probability <= 1
        ):
            fail(
                "configuration advisor.random_probability must be a number "
                "between 0 and 1"
            )
        random_seed = advisor.get("random_seed")
        if not isinstance(random_seed, str) or not random_seed.strip():
            fail("configuration advisor.random_seed must be non-empty text")
    if invocation_policy == "openjev":
        if any(field in advisor for field in random_fields + fixed_fields):
            fail("configuration random/fixed fields do not apply to OpenJev policy")
        interval = advisor.get("openjev_interval", 1)
        if isinstance(interval, bool) or not isinstance(interval, int) or interval <= 0:
            fail("configuration advisor.openjev_interval must be a positive integer")
        config = advisor.get("openjev_policy_config")
        if config is not None:
            if isinstance(config, str):
                config = json.loads(config)
            validate_openjev_policy_config(config)
    if invocation_policy == "fixed":
        if any(field in advisor for field in random_fields + openjev_fields):
            fail("configuration random/OpenJev fields do not apply to fixed policy")
        schedules = [field for field in fixed_fields if advisor.get(field) is not None]
        if len(schedules) != 1:
            fail("configuration fixed policy requires exactly one of fixed_turn or fixed_interval")
        value = advisor[schedules[0]]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            fail(f"configuration advisor.{schedules[0]} must be a positive integer")
    if run.get("advisor") and run["agent"] != "opencode-advisory":
        fail("configuration has advisor settings but agent is not opencode-advisory")
    if run["agent"] == "opencode-advisory" and run.get("mode", "compose") != "compose":
        fail(
            "configuration opencode-advisory currently requires Compose mode "
            "for its sidecar"
        )


def validate_source(
    values: dict[str, Any], label: str, keys: tuple[str, ...]
) -> None:
    selected = [key for key in keys if values.get(key) not in (None, "")]
    if len(selected) > 1:
        fail(
            f"configuration selects multiple sources for {label}: "
            f"{', '.join(selected)}"
        )
    for key in selected:
        value = values[key]
        if key in {"advisory_config", "openjev_policy_config"} and isinstance(value, dict):
            continue
        if not isinstance(value, str) or not value.strip():
            fail(f"configuration.{key} must be a non-empty string")


def validate_catalog(catalog: Any) -> None:
    allowed = {
        "executor_system_prompts",
        "advisor_system_prompts",
        "tool_descriptions",
    }
    if not isinstance(catalog, dict):
        fail("configuration advisory configuration must be a JSON object")
    unknown = set(catalog) - allowed
    if unknown:
        fail(
            "configuration advisory configuration has unknown sections: "
            f"{sorted(unknown)}"
        )
    for section, entries in catalog.items():
        if not isinstance(entries, dict):
            fail(
                "configuration advisory configuration section "
                f"{section} must be an object"
            )
        for name, value in entries.items():
            if not isinstance(value, str) or not value.strip():
                fail(
                    "configuration advisory configuration entry "
                    f"{section}.{name} must be non-empty text"
                )


def validate_openjev_policy_config(config: Any) -> None:
    if not isinstance(config, dict) or config.get("schema_version") != 1:
        fail(
            "configuration OpenJev policy configuration must be a JSON object "
            "with schema_version 1"
        )


def add(command: list[str], flag: str, value: Any) -> None:
    if value is not None and value != "":
        command.extend([flag, str(value)])


def run_command(cli: Path, run: dict[str, Any]) -> list[str]:
    command = [str(cli), "run", str(run["benchmark"])]
    add(command, "--task-id", run["task_id"])
    add(command, "--agent", run["agent"])
    add(command, "--model", run["executor_model"])
    add(command, "--mode", run.get("mode", "compose"))
    add(command, "--gateway-image", run.get("gateway_image"))
    add(command, "--agent-tag", run.get("agent_tag"))
    add(command, "--timeout", run.get("timeout"))
    add(command, "--executor-max-turns", run.get("executor_max_turns"))
    add(command, "--max-budget", run.get("max_budget"))
    add(command, "--agent-reasoning-effort", run.get("agent_reasoning_effort"))
    add(command, "--experiment-id", run.get("experiment_id"))
    if run.get("local", True):
        command.append("--local")

    add(command, "--executor-system-prompt", run.get("executor_system_prompt"))
    add(
        command,
        "--executor-system-prompt-file",
        run.get("executor_system_prompt_file"),
    )
    add(
        command,
        "--executor-system-prompt-variant",
        run.get("executor_system_prompt_variant"),
    )
    config = run.get("advisory_config")
    if isinstance(config, dict):
        config = json.dumps(config, separators=(",", ":"))
    add(command, "--advisory-config", config)
    add(command, "--advisory-config-file", run.get("advisory_config_file"))

    advisor = run.get("advisor", {})
    add(
        command,
        "--advisor-tool-description-variant",
        advisor.get("tool_description_variant"),
    )
    add(command, "--advisor-tool-description", advisor.get("tool_description"))
    add(
        command,
        "--advisor-tool-description-file",
        advisor.get("tool_description_file"),
    )
    add(command, "--advisor-system-prompt", advisor.get("system_prompt"))
    add(command, "--advisor-system-prompt-file", advisor.get("system_prompt_file"))
    add(
        command,
        "--advisor-system-prompt-variant",
        advisor.get("system_prompt_variant"),
    )
    add(command, "--advisor-model", advisor.get("model"))
    add(command, "--advisor-base-url", advisor.get("base_url"))
    add(command, "--advisor-context-mode", advisor.get("context_mode"))
    add(
        command,
        "--advisor-full-context-max-bytes",
        advisor.get("full_context_max_bytes"),
    )
    add(command, "--advisor-timeout-seconds", advisor.get("timeout_seconds"))
    add(
        command,
        "--advisor-invocation-policy",
        advisor.get("invocation_policy"),
    )
    add(
        command,
        "--advisor-random-probability",
        advisor.get("random_probability"),
    )
    add(command, "--advisor-max-calls", advisor.get("max_calls"))
    add(command, "--advisor-random-seed", advisor.get("random_seed"))
    add(command, "--openjev-base-url", advisor.get("openjev_base_url"))
    add(
        command,
        "--advisor-openjev-timeout-seconds",
        advisor.get("openjev_timeout_seconds"),
    )
    add(
        command,
        "--advisor-openjev-interval",
        advisor.get("openjev_interval"),
    )
    openjev_config = advisor.get("openjev_policy_config")
    if isinstance(openjev_config, dict):
        openjev_config = json.dumps(openjev_config, separators=(",", ":"))
    add(command, "--advisor-openjev-policy-config", openjev_config)
    add(
        command,
        "--advisor-openjev-policy-config-file",
        advisor.get("openjev_policy_config_file"),
    )
    add(command, "--advisor-fixed-turn", advisor.get("fixed_turn"))
    add(command, "--advisor-fixed-interval", advisor.get("fixed_interval"))
    if "log_payloads" in advisor:
        command.append(f"--advisor-log-payloads={str(bool(advisor['log_payloads'])).lower()}")
    return command


def is_per_task(benchmark: str) -> bool:
    dockerfile = ROOT / "containers" / "benchmarks" / benchmark / "Dockerfile"
    try:
        return 'eval.benchmark.env="per-task"' in dockerfile.read_text(encoding="utf-8")
    except OSError:
        return False


def build_commands(cli: Path, run: dict[str, Any]) -> list[list[str]]:
    commands: list[list[str]] = []
    platform = str(run.get("platform", "linux/amd64"))
    gateway = str(run.get("gateway_image", "litellm"))
    commands.append([str(cli), "build", "model", gateway, "--platform", platform])
    commands.append(
        [str(cli), "build", "agent", str(run["agent"]), "--platform", platform]
    )

    task = str(run["task_id"])
    per_task = is_per_task(str(run["benchmark"]))
    benchmark_command = [
        str(cli), "build", "bench", str(run["benchmark"]), "--platform", platform
    ]
    if per_task:
        benchmark_command.extend(["--task-id", task])
    commands.append(benchmark_command)

    eval_command = [
        str(cli), "build", "eval", str(run["benchmark"]),
        "--agent", str(run["agent"]),
        "--model", gateway,
        "--platform", platform,
        "--no-pull",
    ]
    if per_task:
        eval_command.extend(["--task-id", task])
    commands.append(eval_command)
    return commands


def print_command(command: list[str]) -> None:
    print("$", shlex.join(command), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--cli", type=Path, default=DEFAULT_CLI)
    parser.add_argument(
        "--build", action="store_true", help="build the required image combination"
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="actually build/run; default is preview only",
    )
    args = parser.parse_args()

    run = json.loads(args.config.read_text(encoding="utf-8"))
    if not isinstance(run, dict):
        fail("configuration must be a JSON object")
    validate(run)
    if args.build and run.get("agent_tag"):
        fail(
            "tagged experiment builds must use the immutable SWE-bench baker; "
            "run this command without --build after baking"
        )

    print(json.dumps({"resolved_run": run}, indent=2), flush=True)
    if args.execute and not args.cli.exists():
        fail(
            f"CLI not found at {args.cli}; run "
            "'cargo build --release --manifest-path cli/Cargo.toml'"
        )

    if args.build:
        for command in build_commands(args.cli, run):
            print_command(command)
            if args.execute:
                subprocess.run(command, cwd=ROOT, check=True, env=os.environ.copy())

    command = run_command(args.cli, run)
    print_command(command)
    if args.execute:
        subprocess.run(command, cwd=ROOT, check=True, env=os.environ.copy())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
