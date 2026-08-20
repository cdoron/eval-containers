"""Configuration for the standalone advisor HTTP gateway."""

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
