"""Thin async wrappers around OpenAI-compatible endpoints."""

import asyncio
import logging
import os

import httpx


logger = logging.getLogger(__name__)
_TRANSIENT_HTTP_STATUSES = {408, 429, 502, 503, 504}


def _timeout_seconds() -> float:
    raw = os.environ.get("EVAL_ADVISOR_TIMEOUT_SECONDS", "300")
    if not raw.isdigit() or not 0 < int(raw) <= 86400:
        raise ValueError(
            "EVAL_ADVISOR_TIMEOUT_SECONDS must be an integer from 1 to 86400"
        )
    return float(raw)


_TIMEOUT = httpx.Timeout(_timeout_seconds())


def _transient_retries() -> int:
    raw = os.environ.get("EVAL_ADVISOR_TRANSIENT_RETRIES", "3")
    if not raw.isdigit() or int(raw) > 100:
        raise ValueError(
            "EVAL_ADVISOR_TRANSIENT_RETRIES must be an integer from 0 to 100"
        )
    return int(raw)


def _retry_delay_seconds() -> float:
    raw = os.environ.get("EVAL_ADVISOR_RETRY_DELAY_SECONDS", "30")
    if not raw.isdigit() or int(raw) > 86400:
        raise ValueError(
            "EVAL_ADVISOR_RETRY_DELAY_SECONDS must be an integer from 0 to 86400"
        )
    return float(raw)


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
    retries = _transient_retries()
    retry_delay = _retry_delay_seconds()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for attempt in range(retries + 1):
            try:
                response = await client.post(
                    _chat_completions_url(base_url),
                    headers=headers,
                    json=payload,
                )
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as exc:
                if (
                    exc.response.status_code not in _TRANSIENT_HTTP_STATUSES
                    or attempt >= retries
                ):
                    raise
                detail = f"HTTP {exc.response.status_code}"
            except httpx.TransportError as exc:
                if attempt >= retries:
                    raise
                detail = type(exc).__name__

            logger.warning(
                "Advisor upstream transient failure: %s; retry %s/%s in %ss",
                detail,
                attempt + 1,
                retries,
                retry_delay,
            )
            await asyncio.sleep(retry_delay)

    raise RuntimeError("Advisor model retry loop ended unexpectedly")
