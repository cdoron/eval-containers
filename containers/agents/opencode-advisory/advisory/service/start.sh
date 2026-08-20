#!/usr/bin/env bash
set -euo pipefail

service_dir=/opt/agent/advisory/service
cd "$service_dir"

exec "$service_dir/.venv/bin/uvicorn" advisor_service.main:app \
  --host "${ADVISOR_SERVICE_HOST:-0.0.0.0}" \
  --port "${ADVISOR_SERVICE_PORT:-8001}"
