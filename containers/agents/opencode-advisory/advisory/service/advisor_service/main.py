"""Standalone advisor HTTP service."""

import logging
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from advisor_service import config
from advisor_service.advisor_runner import get_advice

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


class _SuppressHealthAccessLogs(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        return not (
            isinstance(args, tuple)
            and len(args) >= 3
            and args[1] == "GET"
            and str(args[2]).split("?", 1)[0] == "/health"
        )


logging.getLogger("uvicorn.access").addFilter(_SuppressHealthAccessLogs())

app = FastAPI(title="Advisor HTTP Gateway")


class AdvisoryRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    request: str = Field(
        ...,
        description=(
            "A question, plan, hypothesis, proposed solution, or other material "
            "for the advisor to review."
        ),
    )
    context: str = Field(
        ...,
        description=(
            "The executor's relevant reasoning, plan, observations, actions, "
            "and results so far."
        ),
    )
    task_id: Optional[str] = None
    experiment_id: Optional[str] = None
    harness: Optional[str] = None
    description_variant: Optional[str] = None


class AdvisoryResponse(BaseModel):
    advice: str


@app.get("/health")
async def health() -> dict[str, str]:
    if not config.ADVISOR_MODEL or not config.ADVISOR_BASE_URL:
        raise HTTPException(status_code=503, detail="Advisor service configuration is incomplete")
    return {
        "status": "ok",
        "advisor_model": config.ADVISOR_MODEL,
    }


@app.post("/advisory", response_model=AdvisoryResponse)
async def advisory(request: AdvisoryRequest) -> AdvisoryResponse:
    try:
        advice = await get_advice(
            request=request.request,
            context=request.context,
            task_id=request.task_id,
            experiment_id=request.experiment_id,
            harness=request.harness,
            description_variant=request.description_variant,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - broad fallback for service reliability
        logger.error("Advisor request failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Advisor service request failed") from exc

    return AdvisoryResponse(advice=advice)


def _decision_model_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    suffix = path.lstrip("/")
    if base.endswith("/v1") and suffix.startswith("v1/"):
        suffix = suffix.removeprefix("v1/")
    return f"{base}/{suffix}"


def _openjev_url(path: str) -> str:
    return _decision_model_url(config.OPENJEV_BASE_URL, path)


def _sii_decision_url(path: str) -> str:
    return _decision_model_url(config.SII_DECISION_BASE_URL, path)


async def _proxy_decision_model(
    *,
    name: str,
    url: str,
    api_key: str,
    timeout_seconds: float,
    request: Request,
) -> Response:
    if not url or not api_key:
        raise HTTPException(status_code=503, detail=f"{name} proxy configuration is incomplete")

    try:
        async with httpx.AsyncClient() as client:
            upstream = await client.post(
                url,
                content=await request.body(),
                headers={
                    "authorization": f"Bearer {api_key}",
                    "content-type": request.headers.get("content-type", "application/json"),
                },
                timeout=timeout_seconds,
            )
    except httpx.HTTPError as exc:
        logger.error("%s proxy request failed: %s", name, type(exc).__name__)
        raise HTTPException(status_code=502, detail=f"{name} proxy request failed") from exc

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )


@app.post("/openjev/{path:path}")
async def openjev_proxy(path: str, request: Request) -> Response:
    """Forward only OpenJEV classifier traffic through the egress-enabled sidecar."""
    if not config.OPENJEV_BASE_URL:
        raise HTTPException(status_code=503, detail="OpenJEV proxy configuration is incomplete")
    return await _proxy_decision_model(
        name="OpenJEV",
        url=_openjev_url(path),
        api_key=config.OPENJEV_API_KEY,
        timeout_seconds=config.OPENJEV_TIMEOUT_SECONDS,
        request=request,
    )


@app.post("/sii-decision/{path:path}")
async def sii_decision_proxy(path: str, request: Request) -> Response:
    """Forward only SII decision-model traffic through the egress-enabled sidecar."""
    if not config.SII_DECISION_BASE_URL:
        raise HTTPException(status_code=503, detail="sii-decision proxy configuration is incomplete")
    return await _proxy_decision_model(
        name="sii-decision",
        url=_sii_decision_url(path),
        api_key=config.SII_DECISION_API_KEY,
        timeout_seconds=config.SII_DECISION_TIMEOUT_SECONDS,
        request=request,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "advisor_service.main:app",
        host=config.ADVISOR_SERVICE_HOST,
        port=config.ADVISOR_SERVICE_PORT,
        reload=False,
    )
