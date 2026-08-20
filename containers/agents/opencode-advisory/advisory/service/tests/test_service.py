import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("ADVISOR_MODEL", "test-advisor-model")

from fastapi.testclient import TestClient

from advisor_service.llm_client import _chat_completions_url
from advisor_service.main import app


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

    def test_opencode_tool_forwards_contract_and_metadata(self) -> None:
        tool_source = (
            Path(__file__).resolve().parents[2] / "tools" / "advisory.ts"
        ).read_text(encoding="utf-8")

        for field in (
            "request: args.request",
            "context: args.context",
            "experiment_id: experimentId",
            'harness: "opencode-eval-containers"',
            "description_variant: variant",
        ):
            self.assertIn(field, tool_source)
        self.assertIn("process.env.ADVISORY_EXPERIMENT_ID", tool_source)
        self.assertIn("process.env.ADVISOR_TOOL_DESCRIPTION_VARIANT", tool_source)
        self.assertIn("process.env.ADVISOR_TOOL_DESCRIPTION", tool_source)

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
