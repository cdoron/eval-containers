"""OpenTelemetry setup for advisor model calls."""

import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor


def _trace_endpoint(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1/traces"):
        return normalized
    return f"{normalized}/v1/traces"


def _configure_tracer():
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if endpoint:
        provider = TracerProvider(
            resource=Resource.create(
                {
                    "service.name": "opencode-advisor",
                    "service.namespace": "eval-containers",
                    "eval.agent.name": "opencode-advisory",
                    "eval.call.role": "advisor",
                }
            )
        )
        # Export synchronously when the advisor call ends. Compose may stop the
        # sidecar immediately after the one-shot runner, so a background batch
        # exporter could lose the final advisor response span during teardown.
        provider.add_span_processor(
            SimpleSpanProcessor(
                OTLPSpanExporter(endpoint=_trace_endpoint(endpoint))
            )
        )
        trace.set_tracer_provider(provider)
    return trace.get_tracer("eval-containers.opencode-advisor")


tracer = _configure_tracer()
