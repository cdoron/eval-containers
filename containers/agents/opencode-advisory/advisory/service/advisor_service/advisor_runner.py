"""Advisor model execution for the standalone advisory gateway."""

import json
import logging
from typing import Optional

from advisor_service import config
from advisor_service.llm_client import chat_completions

logger = logging.getLogger(__name__)


async def get_advice(
    request: str,
    context: str,
    *,
    task_id: Optional[str] = None,
    experiment_id: Optional[str] = None,
    harness: Optional[str] = None,
    description_variant: Optional[str] = None,
) -> str:
    """Ask the advisor model to review a request, plan, hypothesis, or question."""
    if not request or not request.strip():
        raise ValueError("Advisory request must be provided.")
    if not config.ADVISOR_MODEL:
        raise RuntimeError("ADVISOR_MODEL is not configured for the advisor service.")
    if not config.ADVISOR_BASE_URL:
        raise RuntimeError("ADVISOR_BASE_URL is not configured for the advisor service.")

    system_prompt = (
        "You are a strategic advisor for a coding agent. "
        "Your job is to give useful, concrete advice to another agent working on a software task. "
        "Review the request using only the information the agent has provided. "
        "The request may be a question, plan, proposed solution, hypothesis, or request for review. "
        "Do not perform the task directly; guide the agent toward the right next action. "
        "Be concise, actionable, and specific."
    )

    if not context or not context.strip():
        raise ValueError("Advisory context must be provided.")
    user_prompt = (
        f"Advisory request: {request.strip()}\n\n"
        f"Executor context and reasoning so far:\n{context.strip()}"
    )

    payload = {
        "model": config.ADVISOR_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    logger.info(
        "Advisor request: model=%s request_chars=%s context_chars=%s task_id=%s experiment_id=%s harness=%s",
        config.ADVISOR_MODEL,
        len(request.strip()),
        len(context.strip()),
        task_id,
        experiment_id,
        harness,
    )
    if config.ADVISOR_LOG_PAYLOADS:
        logger.info(
            "Advisor tool input:\n%s",
            json.dumps(
                {
                    "request": request.strip(),
                    "context": context.strip(),
                    "task_id": task_id,
                    "experiment_id": experiment_id,
                    "harness": harness,
                    "description_variant": description_variant,
                },
                indent=2,
                ensure_ascii=False,
            ),
        )
    response = await chat_completions(
        base_url=config.ADVISOR_BASE_URL,
        api_key=config.ADVISOR_API_KEY,
        payload=payload,
    )

    choices = response.get("choices", [])
    advice = ""
    if choices:
        advice = choices[0].get("message", {}).get("content") or ""
    if not advice.strip():
        raise RuntimeError("Advisor model returned an empty response.")
    if config.ADVISOR_LOG_PAYLOADS:
        logger.info("Advisor tool output:\n%s", advice.strip())
    return advice.strip()
