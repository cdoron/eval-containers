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
RUN node --test \
      /opt/agent/advisory/context/session-context.test.mjs \
      /opt/agent/advisory/intervention/random-router.test.mjs \
      /opt/agent/advisory/intervention/openjev-policy.test.mjs \
      /opt/agent/advisory/intervention/fixed-policy.test.mjs \
      /opt/agent/advisory/intervention/platform-context.test.mjs
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
plugins=""
agent_config=""
opencode_agent_args=()
base_system_prompt="${EVAL_OPENCODE_BASE_SYSTEM_PROMPT:-}"
executor_prompt="${EVAL_EXECUTOR_SYSTEM_PROMPT:-}"
executor_variant="${EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT:-}"
executor_position="${EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION:-append}"
model_context_limit="${EVAL_MODEL_CONTEXT_LIMIT:-}"
model_output_limit="${EVAL_MODEL_OUTPUT_LIMIT:-}"
model_limits=""
advisor_invocation_policy="${EVAL_ADVISOR_INVOCATION_POLICY:-self-initiated}"
advisor_router_port="${EVAL_ADVISOR_ROUTER_PORT:-8012}"
executor_base_url="${OPENAI_BASE_URL:-http://model:4000/v1}"
opencode_base_url="$executor_base_url"
if { [ "$advisor_invocation_policy" = random ] || [ "$advisor_invocation_policy" = openjev ] || [ "$advisor_invocation_policy" = fixed ]; } && \
   { [ -n "$executor_prompt" ] || [ -n "$executor_variant" ]; }; then
  echo "opencode-advisory: platform advisor invocation does not accept an executor system-prompt addition" >&2
  exit 2
fi
case "$executor_position" in
  append|prepend) ;;
  *) echo "opencode-advisory: EVAL_EXECUTOR_SYSTEM_PROMPT_POSITION must be append or prepend" >&2; exit 2;;
esac
if [ -n "$executor_prompt" ] && [ -n "$executor_variant" ]; then
  echo "opencode-advisory: choose either EVAL_EXECUTOR_SYSTEM_PROMPT or EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT" >&2
  exit 2
fi
if [ -n "$executor_variant" ]; then
  executor_prompt="$(python3 /opt/agent/advisory/resolve-config.py executor_system_prompts "$executor_variant")"
fi
if [ -n "$executor_prompt" ]; then
  printf '%s\n' "$executor_prompt" > "$HOME/.config/opencode/executor-system-prompt.txt"
  if [ "$executor_position" = prepend ]; then
    cp /opt/agent/advisory/plugins/prepend-executor-system-prompt.ts \
      "$HOME/.config/opencode/prepend-executor-system-prompt.ts"
    plugins=',"plugin":["./prepend-executor-system-prompt.ts"]'
  else
    instructions=',"instructions":["/home/agent/.config/opencode/executor-system-prompt.txt"]'
  fi
fi
if [ -n "$base_system_prompt" ]; then
  base_system_prompt_json="$(BASE_SYSTEM_PROMPT="$base_system_prompt" python3 -c 'import json, os; print(json.dumps(os.environ["BASE_SYSTEM_PROMPT"]))')"
  agent_config=',"agent":{"eval-base":{"mode":"primary","prompt":'"$base_system_prompt_json"'}}'
  opencode_agent_args=(--agent eval-base)
fi
if [ -n "$model_context_limit" ] || [ -n "$model_output_limit" ]; then
  case "$model_context_limit:$model_output_limit" in
    *[!0-9:]*|:|*:|0:*|*:0)
      echo "opencode-advisory: EVAL_MODEL_CONTEXT_LIMIT and EVAL_MODEL_OUTPUT_LIMIT must both be positive integers" >&2
      exit 2
      ;;
  esac
  if [ "$model_output_limit" -ge "$model_context_limit" ]; then
    echo "opencode-advisory: EVAL_MODEL_OUTPUT_LIMIT must be smaller than EVAL_MODEL_CONTEXT_LIMIT" >&2
    exit 2
  fi
  model_limits=',"limit":{"context":'"$model_context_limit"',"output":'"$model_output_limit"'}'
fi
case "$advisor_invocation_policy" in
  self-initiated) ;;
  random|openjev|fixed)
    if [ "${EVAL_ADVISOR_CONTEXT_MODE:-agent-provided}" != full-session ]; then
      echo "opencode-advisory: platform advisor invocation requires EVAL_ADVISOR_CONTEXT_MODE=full-session" >&2
      exit 2
    fi
    export EVAL_ADVISOR_EXECUTOR_BASE_URL="$executor_base_url"
    node /opt/agent/advisory/intervention/random-router.mjs &
    advisor_router_pid=$!
    cleanup_router() {
      kill "$advisor_router_pid" 2>/dev/null || true
      wait "$advisor_router_pid" 2>/dev/null || true
    }
    trap cleanup_router EXIT
    for _ in $(seq 1 100); do
      kill -0 "$advisor_router_pid" 2>/dev/null || {
        echo "opencode-advisory: advisor intervention router exited during startup" >&2
        exit 2
      }
      if curl -fsS "http://127.0.0.1:${advisor_router_port}/health" >/dev/null 2>&1; then
        break
      fi
      sleep 0.05
    done
    if ! curl -fsS "http://127.0.0.1:${advisor_router_port}/health" >/dev/null 2>&1; then
      echo "opencode-advisory: advisor intervention router did not become ready" >&2
      exit 2
    fi
    opencode_base_url="http://127.0.0.1:${advisor_router_port}/v1"
    ;;
  *)
    echo "opencode-advisory: EVAL_ADVISOR_INVOCATION_POLICY must be self-initiated, random, openjev, or fixed" >&2
    exit 2
    ;;
esac
cat > "$HOME/.config/opencode/opencode.json" <<CONF
{"\$schema":"https://opencode.ai/config.json","model":"eval-containers/${EVAL_MODEL:-default}","small_model":"eval-containers/${EVAL_MODEL:-default}","disabled_providers":["anthropic","openai"],"provider":{"eval-containers":{"npm":"@ai-sdk/openai-compatible","name":"Eval Containers LiteLLM Proxy","options":{"baseURL":"${opencode_base_url}","apiKey":"${OPENAI_API_KEY:-sk-proxy}"},"models":{"${EVAL_MODEL:-default}":{"name":"Eval Containers Proxy Model"${model_limits}}}}},"permission":{"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"allow"},"autoshare":false${agent_config}${instructions}${plugins}}
CONF

if [ -n "$base_system_prompt" ]; then
  if ! configured_base_system_prompt="$(OPENCODE_CONFIG_PATH="$HOME/.config/opencode/opencode.json" python3 -c 'import json, os; config=json.load(open(os.environ["OPENCODE_CONFIG_PATH"], encoding="utf-8")); print(config.get("agent", {}).get("eval-base", {}).get("prompt", ""), end="")')"; then
    echo "opencode-advisory: could not validate the replacement base system prompt configuration" >&2
    exit 2
  fi
  if [ "$configured_base_system_prompt" != "$base_system_prompt" ]; then
    echo "opencode-advisory: OpenCode did not resolve the requested replacement base system prompt" >&2
    exit 2
  fi
  base_system_prompt_sha256="$(BASE_SYSTEM_PROMPT="$base_system_prompt" python3 -c 'import hashlib, os; print(hashlib.sha256(os.environ["BASE_SYSTEM_PROMPT"].encode()).hexdigest())')"
  echo "opencode-advisory: replacement OpenCode base system prompt active (sha256=$base_system_prompt_sha256)" >&2
fi

export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-proxy}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-proxy}"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export ADVISORY_GATEWAY_URL="${ADVISORY_GATEWAY_URL:-http://advisor:8001}"

if [ "$advisor_invocation_policy" != self-initiated ]; then
  rc=0
  opencode run --model "eval-containers/${EVAL_MODEL:-default}" "${opencode_agent_args[@]}" "$TASK" &
  opencode_pid=$!
  stop_platform_mode() {
    kill "$opencode_pid" 2>/dev/null || true
    cleanup_router
    exit 143
  }
  trap stop_platform_mode TERM INT
  wait "$opencode_pid" || rc=$?
  exit "$rc"
fi
exec opencode run --model "eval-containers/${EVAL_MODEL:-default}" "${opencode_agent_args[@]}" "$TASK"
E

ENTRYPOINT ["/run.sh"]
