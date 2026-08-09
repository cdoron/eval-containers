# syntax=docker/dockerfile:1
# SWE-agent (Princeton) — full agent
ARG REGISTRY=ghcr.io/exgentic
ARG REGISTRY_SUFFIX=/
FROM ${REGISTRY}/core${REGISTRY_SUFFIX}agent-base-python:latest
ARG AGENT_VERSION=1.1.0
LABEL eval.type="agent"
LABEL eval.agent.name="swe-agent"
LABEL eval.agent.description="Princeton SWE-agent: Agent-Computer Interface for software engineering"
LABEL eval.agent.runtime="python"
LABEL eval.agent.url="https://github.com/SWE-agent/SWE-agent"
LABEL eval.agent.version="${AGENT_VERSION}"
ENV EVAL_AGENT=swe-agent
# Clone + editable install — SWE-agent's wheel does NOT ship its `config/`
# directory but its runtime asserts `CONFIG_DIR.is_dir()` against it.
RUN git clone --depth 1 --branch v${AGENT_VERSION} https://github.com/SWE-agent/SWE-agent.git /opt/swe-agent && \
    uv pip install --system --no-cache -e /opt/swe-agent
RUN cat > /opt/agent/install.sh <<'I' && chmod +x /opt/agent/install.sh && echo "${AGENT_VERSION}" > /opt/agent/VERSION
#!/bin/bash
set -euo pipefail
# git for the clone below + gitpython at runtime; the slim base ships neither.
apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
git clone --depth 1 --branch v${AGENT_VERSION} https://github.com/SWE-agent/SWE-agent.git /opt/swe-agent 2>/dev/null || true
/opt/agent/setup-uv-venv.sh /opt/swe-agent-venv -e /opt/swe-agent
# swerex's CreateBashSessionRequest.startup_timeout defaults to 1.0s — the
# window to source /root/.bashrc (which runs `conda activate testbed`) and
# reset PS1. Under qemu-emulated amd64 that reliably blows past 1s, raising
# a pexpect.exceptions.TIMEOUT even though the prompt does come up. Patch the
# vendored default rather than the CLI, since sweagent's swe_env.py builds
# the request with no override.
sed -i 's/startup_timeout: float = 1.0/startup_timeout: float = 60.0/' \
  /opt/swe-agent-venv/lib/python*/site-packages/swerex/runtime/abstract.py
# The edit_anthropic tool bundle's install.sh runs `pip install tree-sitter
# tree-sitter-languages` inside the agent's runtime bash session, and the
# eval framework's runner network is internet-less. Pre-install both here at
# build time (when network is available) into whichever pip that session
# will actually use, so pip finds the exact version already satisfied at
# runtime and skips the network call. On swe-bench (and any other benchmark
# using the same harness), /root/.bashrc runs `conda activate testbed` before
# anything else, switching to that env's pip; benchmarks without a testbed
# conda env fall back to whatever pip is on PATH.
testbed_pip=/opt/miniconda3/envs/testbed/bin/pip
if [ -x "$testbed_pip" ]; then
  "$testbed_pip" install --no-cache 'tree-sitter==0.21.3' 'tree-sitter-languages'
elif command -v pip >/dev/null 2>&1; then
  pip install --no-cache 'tree-sitter==0.21.3' 'tree-sitter-languages'
fi
# SWE-agent's LocalDeployment assumes uid-0 root: it writes /root/state.json
# + /root/.swe-agent-env and copies tool bundles into /root/tools. The eval
# framework runs the agent as uid 1002, so open up /root at build time.
chmod 0777 /root && mkdir -p /root/tools && chmod 0777 /root/tools
touch /root/.swe-agent-env /root/state.json && chmod 0666 /root/.swe-agent-env /root/state.json
I

RUN cat > /run.sh <<'E' && chmod +x /run.sh
#!/bin/bash
set -euo pipefail
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-proxy}"
export OPENAI_API_BASE="${OPENAI_BASE_URL:-http://model:4000}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://model:4000}"
# gitpython refuses to read /opt/swe-agent's .git (owned by uid 0, but we're
# uid 1002) without an explicit safe.directory override.
git config --global --add safe.directory /opt/swe-agent
# Raw `git log`/`git diff`/`git branch -a` etc. invoke `less` whenever stdout
# is a tty. In the pexpect-controlled PTY nothing ever sends it a keypress or
# EOF, so the pager blocks until swerex's 30s per-command timeout force-kills
# it — even for one-line output. Disable the pager globally so git commands
# return immediately instead of eating the 30s budget every single time.
git config --global core.pager cat
# The benchmark's actual checkout (at the buggy commit grade.sh diffs against)
# lives at /testbed, not /workspace — LocalRepoConfig's copy() would try to
# stage a copy of it under a basename dir anyway (and fails as non-root via
# chown), so use the `preexisting` repo type (its copy() is a no-op) pointed
# straight at /testbed.
git config --global --add safe.directory /testbed
# problem_statement.path, not .text=$TASK: pydantic-settings' CLI source
# case-folds each flag with a regex (`^(--flag)(.*)`) whose `(.*)` doesn't
# match newlines, so any multi-line --problem_statement.text value is
# silently truncated at its first embedded newline — SWE-agent then runs on
# only the boilerplate lead-in sentence, never the real issue body. Writing
# $TASK to a file and pointing --problem_statement.path at it sidesteps the
# CLI parser entirely.
printf '%s' "$TASK" > /tmp/problem_statement.txt
# output_dir defaults to $CWD/trajectories, and sweagent's cwd is /testbed —
# so its own trajectory JSON lands inside the repo being diffed. The model
# then sees `trajectories/` in `git status`/`git diff` and, on submit review,
# often tries to `git rm -rf` it to clean the diff — deleting the very
# directory sweagent still needs to write its final trajectory file into,
# which crashes with FileNotFoundError after a real submit. Point it outside
# /testbed so it never appears in the repo's own git state.
exec /opt/swe-agent-venv/bin/sweagent run --agent.model.name="openai/${EVAL_MODEL:-default}" --agent.model.per_instance_cost_limit=3 \
  --agent.model.api_base="${OPENAI_BASE_URL:-http://model:4000}" --env.deployment.type=local \
  --env.repo.type=preexisting --env.repo.repo_name=testbed --problem_statement.path=/tmp/problem_statement.txt \
  --output_dir=/tmp/trajectories
E

ENTRYPOINT ["/run.sh"]
