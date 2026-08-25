# syntax=docker/dockerfile:1
# opencode-advisory agent image (SST opencode + advisory command wiring)
ARG REGISTRY=ghcr.io/exgentic
ARG REGISTRY_SUFFIX=/
FROM ${REGISTRY}/core${REGISTRY_SUFFIX}agent-base-node:latest

ARG AGENT_VERSION=1.4.3
LABEL eval.type="agent"
LABEL eval.agent.name="opencode-advisory"
LABEL eval.agent.description="SST opencode with a configurable native advisory tool"
LABEL eval.agent.runtime="node"
LABEL eval.agent.url="https://github.com/sst/opencode"
LABEL eval.agent.version="${AGENT_VERSION}"
ENV EVAL_AGENT=opencode-advisory

RUN npm install -g opencode-ai@${AGENT_VERSION} @opencode-ai/plugin@${AGENT_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY advisory/service/requirements.txt /tmp/advisor-service-requirements.txt
RUN python3 -m venv /opt/agent/advisory/service/.venv \
    && /opt/agent/advisory/service/.venv/bin/pip install --no-cache-dir \
      -r /tmp/advisor-service-requirements.txt \
    && rm /tmp/advisor-service-requirements.txt

COPY advisory /opt/agent/advisory
RUN chmod +x /opt/agent/advisory/service/start.sh

RUN cat > /opt/agent/install.sh <<'I' && chmod +x /opt/agent/install.sh && echo "${AGENT_VERSION}" > /opt/agent/VERSION
#!/bin/bash
set -euo pipefail
for b in node npm npx opencode; do [ -e /opt/agent/node/bin/$b ] && ln -sf /opt/agent/node/bin/$b /usr/local/bin/$b || true; done
I

RUN cat > /run.sh <<'E' && chmod +x /run.sh
#!/bin/bash
set -euo pipefail
mkdir -p "$HOME/.config/opencode" "$HOME/.config/opencode/tools"
cp /opt/agent/advisory/tools/advisory.ts "$HOME/.config/opencode/tools/advisory.ts"
# opencode's runtime (a separate Bun-compiled binary) ignores NODE_PATH and
# resolves imports by walking node_modules upward from advisory.ts's own dir.
ln -sfn "$(npm root -g)" "$HOME/.config/opencode/tools/node_modules"
instructions=""
executor_prompt="${EVAL_EXECUTOR_SYSTEM_PROMPT:-}"
executor_variant="${EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT:-}"
if [ -n "$executor_prompt" ] && [ -n "$executor_variant" ]; then
  echo "opencode-advisory: choose either EVAL_EXECUTOR_SYSTEM_PROMPT or EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT" >&2
  exit 2
fi
if [ -n "$executor_variant" ]; then
  executor_prompt="$(python3 /opt/agent/advisory/resolve-config.py executor_system_prompts "$executor_variant")"
fi
if [ -n "$executor_prompt" ]; then
  printf '%s\n' "$executor_prompt" > "$HOME/.config/opencode/executor-system-prompt.txt"
  instructions=',"instructions":["/home/agent/.config/opencode/executor-system-prompt.txt"]'
fi
cat > "$HOME/.config/opencode/opencode.json" <<CONF
{"\$schema":"https://opencode.ai/config.json","model":"eval-containers/${EVAL_MODEL:-default}","small_model":"eval-containers/${EVAL_MODEL:-default}","disabled_providers":["anthropic","openai"],"provider":{"eval-containers":{"npm":"@ai-sdk/openai-compatible","name":"Eval Containers LiteLLM Proxy","options":{"baseURL":"${OPENAI_BASE_URL:-http://model:4000/v1}","apiKey":"${OPENAI_API_KEY:-sk-proxy}"},"models":{"${EVAL_MODEL:-default}":{"name":"Eval Containers Proxy Model"}}}},"permission":{"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"allow"},"autoshare":false${instructions}}
CONF

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-proxy}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-proxy}"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export ADVISORY_GATEWAY_URL="${ADVISORY_GATEWAY_URL:-http://advisor:8001}"

exec opencode run --model "eval-containers/${EVAL_MODEL:-default}" "$TASK"
E

ENTRYPOINT ["/run.sh"]
