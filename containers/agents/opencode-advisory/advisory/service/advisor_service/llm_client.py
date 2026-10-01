"""Thin async wrappers around OpenAI-compatible endpoints."""

import os

import httpx


def _timeout_seconds() -> float:
    raw = os.environ.get("EVAL_ADVISOR_TIMEOUT_SECONDS", "300")
    if not raw.isdigit() or not 0 < int(raw) <= 86400:
        raise ValueError(
            "EVAL_ADVISOR_TIMEOUT_SECONDS must be an integer from 1 to 86400"
        )
    return float(raw)


_TIMEOUT = httpx.Timeout(_timeout_seconds())


def _chat_completions_url(base_url: str) -> str:
    """Normalize a base URL with or without a trailing /v1."""
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1"):
        return f"{normalized}/chat/completions"
    return f"{normalized}/v1/chat/completions"


async def chat_completions(
    base_url: str,
    api_key: str,
    payload: dict,
) -> dict:
    """POST /v1/chat/completions and return the parsed JSON response."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(
            _chat_completions_url(base_url),
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        return response.json()
