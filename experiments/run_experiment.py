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
    catalog_document: dict[str, Any] | None = None
    for values, keys in (
        (run, ("executor_system_prompt_file", "advisory_config_file")),
        (advisor, ("tool_description_file", "system_prompt_file")),
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
        if key == "advisory_config" and isinstance(value, dict):
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
    add(command, "--timeout", run.get("timeout"))
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
