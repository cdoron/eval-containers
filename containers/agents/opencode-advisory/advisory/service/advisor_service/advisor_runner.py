"""Advisor model execution for the standalone advisory gateway."""

import json
import logging
from numbers import Real
from typing import Optional
from uuid import uuid4

from advisor_service import config
from advisor_service.llm_client import chat_completions
from advisor_service.telemetry import tracer

logger = logging.getLogger(__name__)


def _message(role: str, content: str) -> dict:
    return {
        "role": role,
        "parts": [{"type": "text", "content": content}],
    }


def _usage_value(usage: dict, *names: str) -> Optional[int]:
    for name in names:
        value = usage.get(name)
        if isinstance(value, Real) and not isinstance(value, bool):
            return int(value)
    return None


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

    system_prompt, system_prompt_variant = config.resolve_advisor_system_prompt()

    if not context or not context.strip():
        raise ValueError("Advisory context must be provided.")
    user_prompt = (
        f"Advisory request: {request.strip()}\n\n"
        f"Executor context and reasoning so far:\n{context.strip()}"
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    payload = {
        "model": config.ADVISOR_MODEL,
        "messages": messages,
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
    with tracer.start_as_current_span("advisor.chat") as span:
        span.set_attribute("eval.call.role", "advisor")
        span.set_attribute("eval.advisory.call_id", str(uuid4()))
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("gen_ai.system", "openai")
        span.set_attribute("gen_ai.request.model", config.ADVISOR_MODEL)
        span.set_attribute(
            "gen_ai.input.messages",
            json.dumps(
                [_message(message["role"], message["content"]) for message in messages],
                ensure_ascii=False,
            ),
        )
        for key, value in (
            ("eval.experiment.id", experiment_id),
            ("eval.harness", harness),
            ("eval.advisor.description_variant", description_variant),
            ("eval.advisor.system_prompt_variant", system_prompt_variant),
        ):
            if value:
                span.set_attribute(key, value)

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

        span.set_attribute(
            "gen_ai.output.messages",
            json.dumps([_message("assistant", advice.strip())], ensure_ascii=False),
        )
        span.set_attribute(
            "gen_ai.response.model", response.get("model") or config.ADVISOR_MODEL
        )
        if response.get("id"):
            span.set_attribute("gen_ai.response.id", response["id"])
        finish_reasons = [
            choice.get("finish_reason")
            for choice in choices
            if choice.get("finish_reason")
        ]
        if finish_reasons:
            span.set_attribute(
                "gen_ai.response.finish_reasons", json.dumps(finish_reasons)
            )

        usage = response.get("usage") or {}
        input_tokens = _usage_value(usage, "prompt_tokens", "input_tokens")
        output_tokens = _usage_value(usage, "completion_tokens", "output_tokens")
        total_tokens = _usage_value(usage, "total_tokens")
        if (
            total_tokens is None
            and input_tokens is not None
            and output_tokens is not None
        ):
            total_tokens = input_tokens + output_tokens
        for key, value in (
            ("gen_ai.usage.input_tokens", input_tokens),
            ("gen_ai.usage.output_tokens", output_tokens),
            ("gen_ai.usage.total_tokens", total_tokens),
        ):
            if value is not None:
                span.set_attribute(key, value)

    if config.ADVISOR_LOG_PAYLOADS:
        logger.info("Advisor tool output:\n%s", advice.strip())
    return advice.strip()
