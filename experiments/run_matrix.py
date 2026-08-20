#!/usr/bin/env python3
"""Preview or sequentially execute evaluation configurations from JSON."""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLI = ROOT / "target" / "release" / "eval-containers"


def merge(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(left)
    for key, value in right.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def fail(message: str) -> None:
    raise ValueError(message)


def validate(run: dict[str, Any], index: int) -> None:
    for key in ("benchmark", "task_id", "agent", "executor_model"):
        if not isinstance(run.get(key), (str, int)) or str(run[key]).strip() == "":
            fail(f"runs[{index}].{key} is required")
    hint = run.get("prompt_hint", {})
    mode = hint.get("mode", "none")
    if mode not in {"none", "default", "custom"}:
        fail(f"runs[{index}].prompt_hint.mode must be none, default, or custom")
    if mode == "custom" and not str(hint.get("text", "")).strip():
        fail(f"runs[{index}] custom prompt hint requires prompt_hint.text")
    policy = run.get("advisor", {}).get("prompt_policy", "none")
    if policy not in {"none", "mandatory-first-last"}:
        fail(f"runs[{index}].advisor.prompt_policy is invalid")
    if run.get("advisor") and run["agent"] != "opencode-advisory":
        fail(f"runs[{index}] has advisor settings but agent is not opencode-advisory")
    if run["agent"] == "opencode-advisory" and run.get("mode", "compose") != "compose":
        fail(f"runs[{index}] opencode-advisory currently requires Compose mode for its sidecar")


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

    hint = run.get("prompt_hint", {})
    add(command, "--prompt-hint-mode", hint.get("mode", "none"))
    if hint.get("mode") == "custom":
        add(command, "--prompt-hint", hint.get("text"))

    advisor = run.get("advisor", {})
    add(command, "--advisor-tool-description-variant", advisor.get("tool_description_variant"))
    add(command, "--advisor-tool-description", advisor.get("tool_description"))
    add(command, "--advisory-prompt-policy", advisor.get("prompt_policy"))
    add(command, "--advisor-model", advisor.get("model"))
    add(command, "--advisor-base-url", advisor.get("base_url"))
    if "log_payloads" in advisor:
        command.append(f"--advisor-log-payloads={str(bool(advisor['log_payloads'])).lower()}")
    return command


def is_per_task(benchmark: str) -> bool:
    dockerfile = ROOT / "containers" / "benchmarks" / benchmark / "Dockerfile"
    try:
        return 'eval.benchmark.env="per-task"' in dockerfile.read_text(encoding="utf-8")
    except OSError:
        return False


def build_commands(cli: Path, runs: list[dict[str, Any]]) -> list[list[str]]:
    commands: list[list[str]] = []
    seen: set[tuple[Any, ...]] = set()
    for run in runs:
        platform = str(run.get("platform", "linux/amd64"))
        gateway = str(run.get("gateway_image", "litellm"))
        model_key = ("model", gateway, platform)
        if model_key not in seen:
            commands.append([str(cli), "build", "model", gateway, "--platform", platform])
            seen.add(model_key)

        agent_key = ("agent", run["agent"], platform)
        if agent_key not in seen:
            commands.append([str(cli), "build", "agent", str(run["agent"]), "--platform", platform])
            seen.add(agent_key)

        task = str(run["task_id"])
        per_task = is_per_task(str(run["benchmark"]))
        bench_key = ("bench", run["benchmark"], task if per_task else None, platform)
        if bench_key not in seen:
            command = [str(cli), "build", "bench", str(run["benchmark"]), "--platform", platform]
            if per_task:
                command.extend(["--task-id", task])
            commands.append(command)
            seen.add(bench_key)

        eval_key = ("eval", run["benchmark"], run["agent"], task if per_task else None, platform)
        if eval_key not in seen:
            command = [
                str(cli), "build", "eval", str(run["benchmark"]),
                "--agent", str(run["agent"]),
                "--model", gateway,
                "--platform", platform,
                "--no-pull",
            ]
            if per_task:
                command.extend(["--task-id", task])
            commands.append(command)
            seen.add(eval_key)
    return commands


def print_command(command: list[str]) -> None:
    print("$", shlex.join(command), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--cli", type=Path, default=DEFAULT_CLI)
    parser.add_argument("--build", action="store_true", help="build each unique image combination once")
    parser.add_argument("--execute", action="store_true", help="actually build/run; default is preview only")
    parser.add_argument("--continue-on-failure", action="store_true")
    args = parser.parse_args()

    document = json.loads(args.config.read_text(encoding="utf-8"))
    defaults = document.get("defaults", {})
    raw_runs = document.get("runs")
    if not isinstance(defaults, dict) or not isinstance(raw_runs, list) or not raw_runs:
        fail("configuration requires an object 'defaults' and a non-empty array 'runs'")
    runs = [merge(defaults, item) for item in raw_runs]
    for index, run in enumerate(runs):
        validate(run, index)

    print(json.dumps({"resolved_runs": runs}, indent=2), flush=True)
    if args.execute and not args.cli.exists():
        fail(f"CLI not found at {args.cli}; run 'cargo build --release --manifest-path cli/Cargo.toml'")

    if args.build:
        for command in build_commands(args.cli, runs):
            print_command(command)
            if args.execute:
                subprocess.run(command, cwd=ROOT, check=True, env=os.environ.copy())

    failures = 0
    for run in runs:
        command = run_command(args.cli, run)
        print_command(command)
        if not args.execute:
            continue
        try:
            subprocess.run(command, cwd=ROOT, check=True, env=os.environ.copy())
        except subprocess.CalledProcessError:
            failures += 1
            if not args.continue_on_failure:
                raise
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
