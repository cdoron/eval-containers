"""Thin async wrappers around OpenAI-compatible endpoints."""

import httpx

_TIMEOUT = httpx.Timeout(300.0)


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
