"""Standalone advisor HTTP service."""

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from advisor_service import config
from advisor_service.advisor_runner import get_advice

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "advisor_service.main:app",
        host=config.ADVISOR_SERVICE_HOST,
        port=config.ADVISOR_SERVICE_PORT,
        reload=False,
    )
