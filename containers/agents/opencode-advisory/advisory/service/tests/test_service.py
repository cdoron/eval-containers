import asyncio
import json
import logging
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import httpx

os.environ.setdefault("ADVISOR_MODEL", "test-advisor-model")

from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from advisor_service.advisor_runner import get_advice
from advisor_service.config import DEFAULT_ADVISOR_SYSTEM_PROMPT, resolve_advisor_system_prompt
from advisor_service.llm_client import (
    _chat_completions_url,
    _retry_delay_seconds,
    _timeout_seconds,
    _transient_retries,
    chat_completions,
)
from advisor_service.main import (
    _SuppressHealthAccessLogs,
    _openjev_url,
    _sii_decision_url,
    app,
)
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

    def test_openjev_proxy_uses_sidecar_credentials_and_preserves_payload(self) -> None:
        upstream = AsyncMock(
            return_value=httpx.Response(
                200,
                json={"answers": {"advisor_decision": {"choice": "continue_executor"}}},
            )
        )
        payload = {"model": "openjev", "state": {"turn": 3}, "questions": {}}
        with (
            patch("advisor_service.main.config.OPENJEV_BASE_URL", "https://openjev.test/v1"),
            patch("advisor_service.main.config.OPENJEV_API_KEY", "real-secret"),
            patch("advisor_service.main.httpx.AsyncClient.post", upstream),
        ):
            response = self.client.post(
                "/openjev/v1/systemone",
                json=payload,
                headers={"authorization": "Bearer proxy"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"answers": {"advisor_decision": {"choice": "continue_executor"}}},
        )
        args, kwargs = upstream.await_args
        self.assertEqual(args[0], "https://openjev.test/v1/systemone")
        self.assertEqual(kwargs["headers"]["authorization"], "Bearer real-secret")
        self.assertEqual(json.loads(kwargs["content"]), payload)

    def test_openjev_proxy_rejects_missing_upstream_configuration(self) -> None:
        with patch("advisor_service.main.config.OPENJEV_BASE_URL", ""):
            response = self.client.post("/openjev/v1/systemone", json={})
        self.assertEqual(response.status_code, 503)

    def test_openjev_proxy_url_avoids_duplicate_v1(self) -> None:
        with patch("advisor_service.main.config.OPENJEV_BASE_URL", "https://openjev.test/v1"):
            self.assertEqual(
                _openjev_url("v1/systemone"),
                "https://openjev.test/v1/systemone",
            )

    def test_sii_decision_proxy_uses_sidecar_credentials_and_preserves_payload(self) -> None:
        upstream = AsyncMock(
            return_value=httpx.Response(
                200,
                json={"usage": {"prompt_tokens": 42}, "choices": []},
            )
        )
        payload = {"model": "sii-decision-27b", "prompt": "State: ..."}
        with (
            patch("advisor_service.main.config.SII_DECISION_BASE_URL", "https://sii.test/v1"),
            patch("advisor_service.main.config.SII_DECISION_API_KEY", "sii-secret"),
            patch("advisor_service.main.httpx.AsyncClient.post", upstream),
        ):
            response = self.client.post(
                "/sii-decision/v1/completions",
                json=payload,
                headers={"authorization": "Bearer proxy"},
            )

        self.assertEqual(response.status_code, 200)
        args, kwargs = upstream.await_args
        self.assertEqual(args[0], "https://sii.test/v1/completions")
        self.assertEqual(kwargs["headers"]["authorization"], "Bearer sii-secret")
        self.assertEqual(json.loads(kwargs["content"]), payload)

    def test_sii_decision_proxy_rejects_missing_upstream_configuration(self) -> None:
        with patch("advisor_service.main.config.SII_DECISION_BASE_URL", ""):
            response = self.client.post("/sii-decision/v1/completions", json={})
        self.assertEqual(response.status_code, 503)

    def test_sii_decision_proxy_url_avoids_duplicate_v1(self) -> None:
        with patch("advisor_service.main.config.SII_DECISION_BASE_URL", "https://sii.test/v1"):
            self.assertEqual(
                _sii_decision_url("v1/completions"),
                "https://sii.test/v1/completions",
            )

    def test_base_url_normalization(self) -> None:
        self.assertEqual(
            _chat_completions_url("https://litellm.example.com/v1"),
            "https://litellm.example.com/v1/chat/completions",
        )
        self.assertEqual(
            _chat_completions_url("https://litellm.example.com"),
            "https://litellm.example.com/v1/chat/completions",
        )

    def test_advisor_timeout_uses_bounded_runtime_configuration(self) -> None:
        with patch.dict(os.environ, {"EVAL_ADVISOR_TIMEOUT_SECONDS": "900"}):
            self.assertEqual(_timeout_seconds(), 900.0)
        for value in ("0", "86401", "invalid"):
            with patch.dict(os.environ, {"EVAL_ADVISOR_TIMEOUT_SECONDS": value}):
                with self.assertRaises(ValueError):
                    _timeout_seconds()

    def test_advisor_retry_configuration_is_bounded(self) -> None:
        with patch.dict(
            os.environ,
            {
                "EVAL_ADVISOR_TRANSIENT_RETRIES": "3",
                "EVAL_ADVISOR_RETRY_DELAY_SECONDS": "30",
            },
        ):
            self.assertEqual(_transient_retries(), 3)
            self.assertEqual(_retry_delay_seconds(), 30.0)
        for name, value in (
            ("EVAL_ADVISOR_TRANSIENT_RETRIES", "101"),
            ("EVAL_ADVISOR_TRANSIENT_RETRIES", "invalid"),
            ("EVAL_ADVISOR_RETRY_DELAY_SECONDS", "86401"),
            ("EVAL_ADVISOR_RETRY_DELAY_SECONDS", "invalid"),
        ):
            with patch.dict(os.environ, {name: value}):
                with self.assertRaises(ValueError):
                    if name == "EVAL_ADVISOR_TRANSIENT_RETRIES":
                        _transient_retries()
                    else:
                        _retry_delay_seconds()

    def test_advisor_model_retries_read_timeout_then_succeeds(self) -> None:
        request = httpx.Request("POST", "https://example.test/v1/chat/completions")
        post = AsyncMock(
            side_effect=[
                httpx.ReadTimeout("timed out", request=request),
                httpx.Response(200, request=request, json={"choices": []}),
            ]
        )
        sleep = AsyncMock()
        with (
            patch.dict(
                os.environ,
                {
                    "EVAL_ADVISOR_TRANSIENT_RETRIES": "3",
                    "EVAL_ADVISOR_RETRY_DELAY_SECONDS": "30",
                },
            ),
            patch("advisor_service.llm_client.httpx.AsyncClient.post", post),
            patch("advisor_service.llm_client.asyncio.sleep", sleep),
        ):
            response = asyncio.run(
                chat_completions(
                    "https://example.test/v1",
                    "secret",
                    {"model": "advisor", "messages": []},
                )
            )

        self.assertEqual(response, {"choices": []})
        self.assertEqual(post.await_count, 2)
        sleep.assert_awaited_once_with(30.0)

    def test_advisor_model_retries_retryable_http_status(self) -> None:
        request = httpx.Request("POST", "https://example.test/v1/chat/completions")
        post = AsyncMock(
            side_effect=[
                httpx.Response(503, request=request),
                httpx.Response(200, request=request, json={"choices": []}),
            ]
        )
        sleep = AsyncMock()
        with (
            patch.dict(
                os.environ,
                {
                    "EVAL_ADVISOR_TRANSIENT_RETRIES": "3",
                    "EVAL_ADVISOR_RETRY_DELAY_SECONDS": "30",
                },
            ),
            patch("advisor_service.llm_client.httpx.AsyncClient.post", post),
            patch("advisor_service.llm_client.asyncio.sleep", sleep),
        ):
            response = asyncio.run(
                chat_completions(
                    "https://example.test/v1",
                    "secret",
                    {"model": "advisor", "messages": []},
                )
            )

        self.assertEqual(response, {"choices": []})
        self.assertEqual(post.await_count, 2)
        sleep.assert_awaited_once_with(30.0)

    def test_advisor_model_makes_three_retries_after_initial_timeout(self) -> None:
        request = httpx.Request("POST", "https://example.test/v1/chat/completions")
        post = AsyncMock(
            side_effect=[
                httpx.ReadTimeout("timed out", request=request),
                httpx.ReadTimeout("timed out", request=request),
                httpx.ReadTimeout("timed out", request=request),
                httpx.ReadTimeout("timed out", request=request),
            ]
        )
        sleep = AsyncMock()
        with (
            patch.dict(
                os.environ,
                {
                    "EVAL_ADVISOR_TRANSIENT_RETRIES": "3",
                    "EVAL_ADVISOR_RETRY_DELAY_SECONDS": "30",
                },
            ),
            patch("advisor_service.llm_client.httpx.AsyncClient.post", post),
            patch("advisor_service.llm_client.asyncio.sleep", sleep),
        ):
            with self.assertRaises(httpx.ReadTimeout):
                asyncio.run(
                    chat_completions(
                        "https://example.test/v1",
                        "secret",
                        {"model": "advisor", "messages": []},
                    )
                )

        self.assertEqual(post.await_count, 4)
        self.assertEqual(sleep.await_count, 3)
        self.assertEqual(
            [call.args for call in sleep.await_args_list],
            [(30.0,), (30.0,), (30.0,)],
        )

    def test_advisor_model_does_not_retry_non_transient_http_status(self) -> None:
        request = httpx.Request("POST", "https://example.test/v1/chat/completions")
        post = AsyncMock(return_value=httpx.Response(400, request=request))
        sleep = AsyncMock()
        with (
            patch.dict(
                os.environ,
                {
                    "EVAL_ADVISOR_TRANSIENT_RETRIES": "3",
                    "EVAL_ADVISOR_RETRY_DELAY_SECONDS": "30",
                },
            ),
            patch("advisor_service.llm_client.httpx.AsyncClient.post", post),
            patch("advisor_service.llm_client.asyncio.sleep", sleep),
        ):
            with self.assertRaises(httpx.HTTPStatusError):
                asyncio.run(
                    chat_completions(
                        "https://example.test/v1",
                        "secret",
                        {"model": "advisor", "messages": []},
                    )
                )

        self.assertEqual(post.await_count, 1)
        sleep.assert_not_awaited()

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
        self.assertIn(
            "const advice = await requestAdvice(FULL_SESSION_REQUEST, context)",
            tool_source,
        )
        self.assertIn("process.env.ADVISORY_EXPERIMENT_ID", tool_source)
        self.assertIn("process.env.EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT", tool_source)
        self.assertIn("process.env.EVAL_ADVISOR_TOOL_DESCRIPTION", tool_source)
        self.assertIn("process.env.EVAL_ADVISORY_CONFIG", tool_source)
        self.assertIn("isAutomatedAdvisorCallID(toolContext.callID)", tool_source)
        self.assertIn(
            "const context = await standardSessionContext(toolContext)", tool_source
        )
        self.assertNotIn("readPlatformAdvisorContext", tool_source)
        self.assertNotIn("Missing platform advisor context", tool_source)
        self.assertIn("platformAdvisorMessage(advice)", tool_source)

    def test_platform_invocation_policies_are_wired_through_the_runner(self) -> None:
        root = Path(__file__).resolve().parents[6]
        dockerfile = (
            root / "containers/agents/opencode-advisory/Dockerfile"
        ).read_text(encoding="utf-8")
        compose = (
            root / "containers/agents/opencode-advisory/compose.yaml"
        ).read_text(encoding="utf-8")
        runner = (
            root / "containers/core/runner/run-agent"
        ).read_text(encoding="utf-8")
        router = (
            root
            / "containers/agents/opencode-advisory/advisory/intervention/random-router.mjs"
        ).read_text(encoding="utf-8")
        openjev_policy = (
            root
            / "containers/agents/opencode-advisory/advisory/intervention/openjev-policy.mjs"
        ).read_text(encoding="utf-8")
        sii_policy = (
            root
            / "containers/agents/opencode-advisory/advisory/intervention/sii-decision-policy.mjs"
        ).read_text(encoding="utf-8")
        decision_client = (
            root
            / "containers/agents/opencode-advisory/advisory/intervention/decision-model-client.mjs"
        ).read_text(encoding="utf-8")
        policy_config = (
            root
            / "containers/agents/opencode-advisory/advisory/intervention/policy-config.mjs"
        ).read_text(encoding="utf-8")
        tool_source = (
            root
            / "containers/agents/opencode-advisory/advisory/tools/advisory.ts"
        ).read_text(encoding="utf-8")
        client_source = (
            root
            / "containers/agents/opencode-advisory/advisory/service/advisor_service/llm_client.py"
        ).read_text(encoding="utf-8")

        for variable in (
            "EVAL_ADVISOR_INVOCATION_POLICY",
            "EVAL_ADVISOR_RANDOM_PROBABILITY",
            "EVAL_ADVISOR_MAX_CALLS",
            "EVAL_ADVISOR_RANDOM_SEED",
        ):
            self.assertIn(variable, compose)
            self.assertIn(variable, runner)
            self.assertTrue(variable in dockerfile or variable in router)
        self.assertIn("EVAL_ADVISOR_TIMEOUT_SECONDS", compose)
        self.assertIn("EVAL_ADVISOR_TIMEOUT_SECONDS", runner)
        self.assertIn("EVAL_ADVISOR_TIMEOUT_SECONDS", client_source)
        for variable in (
            "EVAL_ADVISOR_TRANSIENT_RETRIES",
            "EVAL_ADVISOR_RETRY_DELAY_SECONDS",
        ):
            self.assertIn(variable, compose)
            self.assertIn(variable, runner)
            self.assertIn(variable, openjev_policy)
            self.assertIn(variable, sii_policy)
            self.assertIn(variable, client_source)
        self.assertIn("advisor.decision_model.retry", decision_client)
        self.assertNotIn("EVAL_ADVISOR_TRANSIENT_RETRIES", tool_source)
        self.assertIn("random-router.mjs", dockerfile)
        self.assertIn("platform advisor invocation requires", dockerfile)
        self.assertIn("openjev", dockerfile)
        for variable in (
            "OPENJEV_BASE_URL",
            "OPENJEV_API_KEY",
            "SII_DECISION_BASE_URL",
            "SII_DECISION_API_KEY",
            "EVAL_ADVISOR_OPENJEV_TIMEOUT_SECONDS",
            "EVAL_ADVISOR_OPENJEV_INTERVAL",
            "EVAL_ADVISOR_OPENJEV_POLICY_CONFIG",
        ):
            self.assertIn(variable, compose)
            self.assertIn(variable, runner)
            self.assertIn(variable, router)
        self.assertIn("OpenJevInterventionPolicy", router)
        for variable in (
            "SII_DECISION_BASE_URL",
            "SII_DECISION_API_KEY",
            "EVAL_ADVISOR_SII_DECISION_TIMEOUT_SECONDS",
            "EVAL_ADVISOR_SII_DECISION_INTERVAL",
            "EVAL_ADVISOR_SII_DECISION_LOGPROBS",
            "EVAL_ADVISOR_SII_DECISION_POLICY_CONFIG",
        ):
            self.assertIn(variable, compose)
            self.assertIn(variable, runner)
            self.assertIn(variable, router)
        self.assertIn("SiiDecisionInterventionPolicy", router)
        self.assertIn("parseAdvisorCallLimit", openjev_policy)
        self.assertIn("'unlimited', or omitted", policy_config)
        for variable in ("EVAL_ADVISOR_FIXED_TURN", "EVAL_ADVISOR_FIXED_INTERVAL"):
            self.assertIn(variable, compose)
            self.assertIn(variable, runner)
            self.assertIn(variable, router)
        self.assertIn("FixedInterventionPolicy", router)

    def test_executor_system_prompt_uses_opencode_instructions(self) -> None:
        dockerfile = (Path(__file__).resolve().parents[3] / "Dockerfile").read_text(
            encoding="utf-8"
        )
        prepend_plugin = (
            Path(__file__).resolve().parents[2]
            / "plugins"
            / "prepend-executor-system-prompt.ts"
        ).read_text(encoding="utf-8")
        runner = (
            Path(__file__).resolve().parents[6] / "containers/core/runner/run-agent"
        ).read_text(encoding="utf-8")

        self.assertIn(
            '"instructions":["/home/agent/.config/opencode/executor-system-prompt.txt"]',
            dockerfile,
        )
        self.assertIn('if [ "${EVAL_AGENT:-}" = "opencode-advisory" ]; then', runner)
        for assignment in (
            '"EVAL_EXECUTOR_SYSTEM_PROMPT=${EVAL_EXECUTOR_SYSTEM_PROMPT:-}"',
            '"EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT=${EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT:-}"',
            '"EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION=${EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION:-append}"',
            '"EVAL_OPENCODE_BASE_SYSTEM_PROMPT=${EVAL_OPENCODE_BASE_SYSTEM_PROMPT:-}"',
            '"EVAL_MODEL_CONTEXT_LIMIT=${EVAL_MODEL_CONTEXT_LIMIT:-}"',
            '"EVAL_MODEL_OUTPUT_LIMIT=${EVAL_MODEL_OUTPUT_LIMIT:-}"',
        ):
            self.assertIn(assignment, runner)
        self.assertIn(
            'EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION must be append or prepend',
            dockerfile,
        )
        self.assertIn(
            'prepend-executor-system-prompt.ts',
            dockerfile,
        )
        self.assertIn(
            'output.system.splice(0, output.system.length,',
            prepend_plugin,
        )

        policies = Path(__file__).resolve().parents[2] / "system-prompts"
        for name in ("mandatory-first-last.txt", "anthropic-advisory-instructions.txt"):
            self.assertTrue((policies / name).read_text(encoding="utf-8").strip())

    def test_optional_base_prompt_uses_native_opencode_v1_agent_config(self) -> None:
        root = Path(__file__).resolve().parents[6]
        dockerfile = (
            root / "containers/agents/opencode-advisory/Dockerfile"
        ).read_text(encoding="utf-8")
        base_prompt = (
            root / "containers/benchmarks/appworld/opencode-system-prompt.txt"
        ).read_text(encoding="utf-8")

        self.assertIn(
            'base_system_prompt="${EVAL_OPENCODE_BASE_SYSTEM_PROMPT:-}"',
            dockerfile,
        )
        self.assertIn(
            'agent_config=\',"agent":{"eval-base":{"mode":"primary","prompt":\'',
            dockerfile,
        )
        self.assertIn("opencode_agent_args=(--agent eval-base)", dockerfile)
        self.assertIn('"${opencode_agent_args[@]}" "$TASK"', dockerfile)
        self.assertNotIn("opencode debug agent eval-base", dockerfile)
        self.assertIn('OPENCODE_CONFIG_PATH="$HOME/.config/opencode/opencode.json"', dockerfile)
        self.assertIn(
            "replacement OpenCode base system prompt active",
            dockerfile,
        )
        self.assertIn(
            "You are an agent operating in the AppWorld simulated environment.",
            base_prompt,
        )
        self.assertNotIn(
            "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
            base_prompt,
        )
        for coding_prompt_term in ("codebase", "Git", "linting", "code style"):
            self.assertNotIn(coding_prompt_term, base_prompt)

    def test_optional_custom_model_limits_are_written_to_opencode_config(self) -> None:
        dockerfile = (Path(__file__).resolve().parents[3] / "Dockerfile").read_text(
            encoding="utf-8"
        )

        self.assertIn('model_context_limit="${EVAL_MODEL_CONTEXT_LIMIT:-}"', dockerfile)
        self.assertIn('model_output_limit="${EVAL_MODEL_OUTPUT_LIMIT:-}"', dockerfile)
        self.assertIn(
            ',"limit":{"context":',
            dockerfile,
        )
        self.assertIn(
            "EVAL_MODEL_OUTPUT_LIMIT must be smaller than EVAL_MODEL_CONTEXT_LIMIT",
            dockerfile,
        )

    def test_executor_advisor_and_openjev_credentials_are_configured_separately(self) -> None:
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
            "OPENJEV_BASE_URL",
            "OPENJEV_API_KEY",
        ):
            self.assertIn(f"{name}=", env_example)
        self.assertIn("OPENAI_API_BASE: ${OPENAI_API_BASE:?}", shared_compose)
        self.assertIn("OPENAI_API_KEY: ${OPENAI_API_KEY:?}", shared_compose)
        self.assertIn("ADVISOR_BASE_URL: ${ADVISOR_BASE_URL:-}", advisor_compose)
        self.assertIn("ADVISOR_API_KEY: ${ADVISOR_API_KEY:-none}", advisor_compose)
        self.assertIn("OPENJEV_BASE_URL: ${OPENJEV_BASE_URL:-}", advisor_compose)
        self.assertIn("OPENJEV_API_KEY: ${OPENJEV_API_KEY:-}", advisor_compose)
        self.assertIn("SII_DECISION_BASE_URL: ${SII_DECISION_BASE_URL:-}", advisor_compose)
        self.assertIn("SII_DECISION_API_KEY: ${SII_DECISION_API_KEY:-}", advisor_compose)
        self.assertNotIn("ADVISOR_BASE_URL=$OPENAI_API_BASE", env_example)
        self.assertNotIn("ADVISOR_API_KEY=$OPENAI_API_KEY", env_example)

        run_guide = (
            root / "containers" / "agents" / "opencode-advisory" / "README-RUNS.md"
        ).read_text(encoding="utf-8")
        self.assertIn('--openjev-base-url "$OPENJEV_BASE_URL"', run_guide)
        self.assertNotIn("openjev-svc.advisor-erel", run_guide)

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
