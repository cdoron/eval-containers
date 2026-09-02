"""Configuration for the standalone advisor HTTP gateway."""

import json
import os


ADVISOR_BASE_URL: str = os.getenv("ADVISOR_BASE_URL", "").rstrip("/")
ADVISOR_API_KEY: str = os.getenv("ADVISOR_API_KEY", "none")
ADVISOR_MODEL: str = os.getenv("ADVISOR_MODEL", "")
ADVISOR_SERVICE_HOST: str = os.getenv("ADVISOR_SERVICE_HOST", "0.0.0.0")
ADVISOR_SERVICE_PORT: int = int(os.getenv("ADVISOR_SERVICE_PORT", "8001"))
ADVISOR_LOG_PAYLOADS: bool = os.getenv("ADVISOR_LOG_PAYLOADS", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

DEFAULT_ADVISOR_SYSTEM_PROMPT = (
    "You are a strategic advisor for a coding agent. "
    "Your job is to give useful, concrete advice to another agent working on a software task. "
    "Review the request using only the information the agent has provided. "
    "The request may be a question, plan, proposed solution, hypothesis, or request for review. "
    "Do not perform the task directly; guide the agent toward the right next action. "
    "Be concise, actionable, and specific."
)


def resolve_advisor_system_prompt() -> tuple[str, str]:
    """Resolve direct text, a named catalog entry, or the built-in default."""
    direct = os.getenv("EVAL_ADVISOR_SYSTEM_PROMPT", "").strip()
    variant = os.getenv("EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT", "").strip()
    if direct and variant:
        raise RuntimeError(
            "Choose either EVAL_ADVISOR_SYSTEM_PROMPT or "
            "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT."
        )
    if direct:
        return direct, "custom"
    if not variant:
        return DEFAULT_ADVISOR_SYSTEM_PROMPT, "default"

    raw = os.getenv("EVAL_ADVISORY_CONFIG", "").strip()
    if not raw:
        raise RuntimeError(
            f"Advisor system prompt variant '{variant}' requires EVAL_ADVISORY_CONFIG."
        )
    try:
        catalog = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"EVAL_ADVISORY_CONFIG is not valid JSON: {error}") from error
    if not isinstance(catalog, dict):
        raise RuntimeError("EVAL_ADVISORY_CONFIG must be a JSON object.")
    entries = catalog.get("advisor_system_prompts", {})
    value = entries.get(variant) if isinstance(entries, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(
            f"Unknown or empty advisor system prompt variant '{variant}'."
        )
    return value.strip(), variant
