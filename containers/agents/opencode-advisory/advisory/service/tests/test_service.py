import asyncio
import json
import logging
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("ADVISOR_MODEL", "test-advisor-model")

from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from advisor_service.advisor_runner import get_advice
from advisor_service.config import DEFAULT_ADVISOR_SYSTEM_PROMPT, resolve_advisor_system_prompt
from advisor_service.llm_client import _chat_completions_url
from advisor_service.main import _SuppressHealthAccessLogs, app
from advisor_service.telemetry import _trace_endpoint


class AdvisorServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health_succeeds(self) -> None:
        with patch("advisor_service.main.config.ADVISOR_BASE_URL", "https://example.test/v1"):
            response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertNotIn("base_url", response.json())

    def test_health_rejects_incomplete_configuration(self) -> None:
        with patch("advisor_service.main.config.ADVISOR_MODEL", ""):
            response = self.client.get("/health")

        self.assertEqual(response.status_code, 503)

    def test_health_access_logs_are_suppressed(self) -> None:
        access_filter = _SuppressHealthAccessLogs()
        health = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            "",
            0,
            '%s - "%s %s HTTP/%s" %d',
            (("127.0.0.1", 1234), "GET", "/health", "1.1", 200),
            None,
        )
        advisory = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            "",
            0,
            '%s - "%s %s HTTP/%s" %d',
            (("127.0.0.1", 1234), "POST", "/advisory", "1.1", 200),
            None,
        )

        self.assertFalse(access_filter.filter(health))
        self.assertTrue(access_filter.filter(advisory))

    def test_missing_request_is_rejected(self) -> None:
        response = self.client.post("/advisory", json={"context": "Current findings."})

        self.assertEqual(response.status_code, 422)

    def test_missing_context_is_rejected(self) -> None:
        response = self.client.post("/advisory", json={"request": "Review my plan."})

        self.assertEqual(response.status_code, 422)

    def test_advisory_returns_advice_when_model_call_is_mocked(self) -> None:
        get_advice = AsyncMock(return_value="Check parser.py first.")
        with patch("advisor_service.main.get_advice", get_advice):
            response = self.client.post(
                "/advisory",
                json={
                    "request": "Review this investigation plan.",
                    "context": "The parser test fails on empty input.",
                    "experiment_id": "experiment-1",
                    "harness": "opencode-eval-containers",
                    "description_variant": "neutral",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"advice": "Check parser.py first."})
        get_advice.assert_awaited_once()

    def test_advisory_failure_does_not_expose_upstream_details(self) -> None:
        get_advice = AsyncMock(side_effect=RuntimeError("https://user:secret@example.test"))
        with patch("advisor_service.main.get_advice", get_advice):
            response = self.client.post(
                "/advisory",
                json={"request": "Review this plan.", "context": "Current findings."},
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "Advisor service request failed"})
        self.assertNotIn("secret", response.text)

    def test_base_url_normalization(self) -> None:
        self.assertEqual(
            _chat_completions_url("https://litellm.example.com/v1"),
            "https://litellm.example.com/v1/chat/completions",
        )
        self.assertEqual(
            _chat_completions_url("https://litellm.example.com"),
            "https://litellm.example.com/v1/chat/completions",
        )

    def test_trace_endpoint_normalization(self) -> None:
        self.assertEqual(
            _trace_endpoint("http://otelcol:4318"),
            "http://otelcol:4318/v1/traces",
        )
        self.assertEqual(
            _trace_endpoint("http://otelcol:4318/v1/traces"),
            "http://otelcol:4318/v1/traces",
        )

    def test_advisor_model_call_emits_genai_span(self) -> None:
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        response = {
            "id": "chatcmpl-advisor-1",
            "model": "resolved-advisor-model",
            "choices": [
                {
                    "message": {"content": "Check parser.py first."},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 30,
                "total_tokens": 150,
            },
        }

        with (
            patch.dict(
                os.environ,
                {
                    "EVAL_ADVISOR_SYSTEM_PROMPT": "",
                    "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT": "",
                },
            ),
            patch("advisor_service.advisor_runner.tracer", provider.get_tracer("test")),
            patch(
                "advisor_service.advisor_runner.chat_completions",
                AsyncMock(return_value=response),
            ),
            patch(
                "advisor_service.advisor_runner.config.ADVISOR_BASE_URL",
                "https://example.test/v1",
            ),
            patch(
                "advisor_service.advisor_runner.config.ADVISOR_MODEL",
                "configured-advisor-model",
            ),
        ):
            advice = asyncio.run(
                get_advice(
                    "Review this plan.",
                    "The parser test fails on empty input.",
                    experiment_id="experiment-1",
                    harness="opencode-eval-containers",
                    description_variant="neutral",
                )
            )

        self.assertEqual(advice, "Check parser.py first.")
        spans = exporter.get_finished_spans()
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertEqual(span.name, "advisor.chat")
        self.assertEqual(span.attributes["eval.call.role"], "advisor")
        self.assertEqual(span.attributes["eval.experiment.id"], "experiment-1")
        self.assertEqual(span.attributes["eval.advisor.system_prompt_variant"], "default")
        self.assertEqual(
            span.attributes["gen_ai.request.model"], "configured-advisor-model"
        )
        self.assertEqual(
            span.attributes["gen_ai.response.model"], "resolved-advisor-model"
        )
        self.assertEqual(span.attributes["gen_ai.usage.input_tokens"], 120)
        self.assertEqual(span.attributes["gen_ai.usage.output_tokens"], 30)
        self.assertEqual(span.attributes["gen_ai.usage.total_tokens"], 150)
        self.assertFalse(
            any(key.startswith("gen_ai.cost.") for key in span.attributes)
        )

        inputs = json.loads(span.attributes["gen_ai.input.messages"])
        outputs = json.loads(span.attributes["gen_ai.output.messages"])
        self.assertIn("Review this plan.", inputs[1]["parts"][0]["content"])
        self.assertIn(
            "The parser test fails on empty input.",
            inputs[1]["parts"][0]["content"],
        )
        self.assertEqual(
            outputs[0]["parts"][0]["content"], "Check parser.py first."
        )

    def test_opencode_tool_forwards_contract_and_metadata(self) -> None:
        tool_source = (
            Path(__file__).resolve().parents[2] / "tools" / "advisory.ts"
        ).read_text(encoding="utf-8")

        for field in (
            "request,",
            "context,",
            "experiment_id: experimentId",
            'harness: "opencode-eval-containers"',
            "description_variant: resolvedDescription.variant",
        ):
            self.assertIn(field, tool_source)
        self.assertIn("return requestAdvice(args.request, args.context)", tool_source)
        self.assertIn("return requestAdvice(task, context)", tool_source)
        self.assertIn("process.env.ADVISORY_EXPERIMENT_ID", tool_source)
        self.assertIn("process.env.EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT", tool_source)
        self.assertIn("process.env.EVAL_ADVISOR_TOOL_DESCRIPTION", tool_source)
        self.assertIn("process.env.EVAL_ADVISORY_CONFIG", tool_source)

    def test_executor_system_prompt_uses_opencode_instructions(self) -> None:
        dockerfile = (Path(__file__).resolve().parents[3] / "Dockerfile").read_text(
            encoding="utf-8"
        )
        runner = (
            Path(__file__).resolve().parents[6] / "containers/core/runner/run-agent"
        ).read_text(encoding="utf-8")

        self.assertIn(
            '"instructions":["/home/agent/.config/opencode/executor-system-prompt.txt"]',
            dockerfile,
        )
        self.assertIn(
            'EVAL_EXECUTOR_SYSTEM_PROMPT="${EVAL_EXECUTOR_SYSTEM_PROMPT:-}"',
            runner,
        )
        self.assertIn(
            'EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT="${EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT:-}"',
            runner,
        )

        policies = Path(__file__).resolve().parents[2] / "system-prompts"
        for name in ("mandatory-first-last.txt", "anthropic-advisory-instructions.txt"):
            self.assertTrue((policies / name).read_text(encoding="utf-8").strip())

    def test_executor_and_advisor_credentials_are_configured_separately(self) -> None:
        root = Path(__file__).resolve().parents[6]
        env_example = (root / ".env.example").read_text(encoding="utf-8")
        shared_compose = (
            root / "containers" / "compose" / "services.yaml"
        ).read_text(encoding="utf-8")
        advisor_compose = (
            Path(__file__).resolve().parents[3] / "compose.yaml"
        ).read_text(encoding="utf-8")

        for name in (
            "OPENAI_API_BASE",
            "OPENAI_API_KEY",
            "ADVISOR_BASE_URL",
            "ADVISOR_API_KEY",
        ):
            self.assertIn(f"{name}=", env_example)
        self.assertIn("OPENAI_API_BASE: ${OPENAI_API_BASE:?}", shared_compose)
        self.assertIn("OPENAI_API_KEY: ${OPENAI_API_KEY:?}", shared_compose)
        self.assertIn("ADVISOR_BASE_URL: ${ADVISOR_BASE_URL:-}", advisor_compose)
        self.assertIn("ADVISOR_API_KEY: ${ADVISOR_API_KEY:-none}", advisor_compose)
        self.assertNotIn("ADVISOR_BASE_URL=$OPENAI_API_BASE", env_example)
        self.assertNotIn("ADVISOR_API_KEY=$OPENAI_API_KEY", env_example)

    def test_advisor_system_prompt_supports_default_direct_and_named_sources(self) -> None:
        with patch.dict(
            os.environ,
            {
                "EVAL_ADVISOR_SYSTEM_PROMPT": "",
                "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT": "",
                "EVAL_ADVISORY_CONFIG": "",
            },
        ):
            self.assertEqual(
                resolve_advisor_system_prompt(),
                (DEFAULT_ADVISOR_SYSTEM_PROMPT, "default"),
            )

        with patch.dict(
            os.environ,
            {
                "EVAL_ADVISOR_SYSTEM_PROMPT": "Direct advisor prompt",
                "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT": "",
            },
        ):
            self.assertEqual(
                resolve_advisor_system_prompt(),
                ("Direct advisor prompt", "custom"),
            )

        catalog = json.dumps(
            {"advisor_system_prompts": {"reviewer": "Named advisor prompt"}}
        )
        with patch.dict(
            os.environ,
            {
                "EVAL_ADVISOR_SYSTEM_PROMPT": "",
                "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT": "reviewer",
                "EVAL_ADVISORY_CONFIG": catalog,
            },
        ):
            self.assertEqual(
                resolve_advisor_system_prompt(),
                ("Named advisor prompt", "reviewer"),
            )

    def test_tool_descriptions_are_valid_json(self) -> None:
        import json

        descriptions_path = (
            Path(__file__).resolve().parents[2] / "tool-descriptions.json"
        )
        descriptions = json.loads(descriptions_path.read_text(encoding="utf-8"))
        self.assertIn("neutral", descriptions)
        self.assertIn("mandatory", descriptions)
        self.assertTrue(all(isinstance(value, str) and value for value in descriptions.values()))


if __name__ == "__main__":
    unittest.main()
