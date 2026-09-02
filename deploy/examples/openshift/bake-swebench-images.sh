#!/usr/bin/env bash
# bake-swebench-images.sh — build+push every SWE-bench task's bench+eval
# Docker images for one agent, ahead of a real run-benchmark.sh run, with
# bounded concurrency (PARALLELISM, default 1 = sequential). PARALLELISM=50
# overwhelmed a single-VM Colima daemon when run-benchmark.sh baked images
# inline (see its SWE-bench fan-out) — start low and watch `docker info`/
# Activity Monitor before raising it. Baking ahead of time means a later
# run-benchmark.sh pass finds every image already pushed and skips straight
# to render/apply/wait.
#
# Resumable: build_and_push skips any image that's already pushed, checked
# against the registry directly (docker buildx imagetools inspect), so
# killing this partway through and re-running just picks up where it left off.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENT="${AGENT:-opencode}"
BENCHMARK="${BENCHMARK:-swe-bench}"
GATEWAY_IMAGE="${GATEWAY_IMAGE:-litellm}"
PLATFORM="${PLATFORM:-linux/amd64}"
REBUILD="${REBUILD:-false}"
REBUILD_AGENT="${REBUILD_AGENT:-$REBUILD}"
REBUILD_MODEL="${REBUILD_MODEL:-$REBUILD}"
REBUILD_BENCH="${REBUILD_BENCH:-$REBUILD}"
REBUILD_EVAL="${REBUILD_EVAL:-$REBUILD}"
TASK_IDS_FILE="${TASK_IDS_FILE:-}"
TASK_LIMIT="${TASK_LIMIT:-}"
PARALLELISM="${PARALLELISM:-1}"
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR/output}"

usage() {
  cat <<'EOF'
Usage: bake-swebench-images.sh TASK_IDS_FILE

Build and push the benchmark and eval image for every SWE-bench task id in the
given newline-separated text file. Blank lines are ignored. Existing registry
images are skipped unless REBUILD=true.

Required environment:
  EVAL_CONTAINERS_DIR  Path to an eval-containers checkout with the release CLI.
  REGISTRY             Registry namespace to push into.

Optional environment:
  AGENT, GATEWAY_IMAGE, PLATFORM, PARALLELISM, OUTPUT_DIR, TASK_LIMIT
  REBUILD                 Rebuild every image when true. Default: false.
  REBUILD_AGENT/MODEL     Override rebuilding each shared image.
  REBUILD_BENCH/EVAL      Override rebuilding each per-task image.
EOF
}

[[ "${1:-}" == -h || "${1:-}" == --help ]] && { usage; exit 0; }
[[ $# -le 1 ]] || { echo "error: expected one task-list file" >&2; usage >&2; exit 1; }
if [[ $# -eq 1 ]]; then
  TASK_IDS_FILE="$1"
fi
[[ -n "$TASK_IDS_FILE" ]] || {
  echo "error: pass the task-list text file as the first argument" >&2
  usage >&2
  exit 1
}

[[ "$PARALLELISM" =~ ^[0-9]+$ && "$PARALLELISM" -gt 0 ]] || {
  echo "error: PARALLELISM must be a positive integer (got '$PARALLELISM')" >&2; exit 1
}
[[ -z "$TASK_LIMIT" || "$TASK_LIMIT" =~ ^[0-9]+$ && "$TASK_LIMIT" -gt 0 ]] || {
  echo "error: TASK_LIMIT must be a positive integer when set (got '$TASK_LIMIT')" >&2; exit 1
}

[[ -f "$TASK_IDS_FILE" ]] || { echo "error: TASK_IDS_FILE=$TASK_IDS_FILE not found" >&2; exit 1; }

TASK_LIST=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  TASK_LIST+=("$line")
done < "$TASK_IDS_FILE"
[[ -n "$TASK_LIMIT" ]] && TASK_LIST=("${TASK_LIST[@]:0:$TASK_LIMIT}")
[[ ${#TASK_LIST[@]} -eq 0 ]] && { echo "error: task list resolved empty — check TASK_IDS_FILE contents" >&2; exit 1; }

: "${EVAL_CONTAINERS_DIR:?set EVAL_CONTAINERS_DIR to an eval-containers checkout}"
: "${REGISTRY:?set REGISTRY}"

[[ -x "$EVAL_CONTAINERS_DIR/target/release/eval-containers" ]] \
  && PATH="$EVAL_CONTAINERS_DIR/target/release:$PATH"
command -v eval-containers >/dev/null || {
  echo "error: 'eval-containers' CLI not found — build it (cargo build --release) inside EVAL_CONTAINERS_DIR" >&2
  exit 1
}
command -v docker >/dev/null || { echo "error: 'docker' not found on PATH" >&2; exit 1; }

log() { echo "[bake-swebench-images] $*"; }

# Skip-if-exists build_and_push. Diverges from run-benchmark.sh's copy in two
# ways:
# 1. Checks the REMOTE registry (buildx imagetools, no pull) instead of local
#    `docker image inspect`. run-benchmark.sh builds one task at a time so
#    local-cache presence is a fine proxy for "already pushed" there — but
#    baking hundreds of unique per-task images and keeping every one cached
#    locally forever doesn't fit a normal disk (we filled a 300GB Colima VM
#    at ~220/500 tasks). Checking the registry directly lets local images
#    (and build cache) be pruned after each push without breaking resumability.
# 2. Retries build+push up to 3x with a 20s backoff — every build resolves
#    docker.io for BuildKit's frontend image, and that DNS lookup fails
#    intermittently under sustained concurrent load even with a pinned
#    resolver; a bare retry a few seconds later is enough to clear it.
build_and_push() {  # $1=label $2=nested-path $3=rebuild, shift 3 -> build args
  local label="$1" nested="$2" rebuild="$3"; shift 3
  if [[ "$rebuild" != true ]] && docker buildx imagetools inspect "$REGISTRY/${nested}:latest" &>/dev/null; then
    log "skip $label (exists)"; return
  fi
  local push_args=() skip_next=false a
  for a in "$@"; do
    if $skip_next; then skip_next=false; continue; fi
    [[ "$a" == "--model" ]] && { skip_next=true; continue; }
    push_args+=("$a")
  done
  local attempt
  for attempt in 1 2 3; do
    if eval-containers --registry "$REGISTRY" build "$@" --platform "$PLATFORM" \
      && eval-containers --registry "$REGISTRY" push "${push_args[@]}"; then
      docker image rm "$REGISTRY/${nested}:latest" &>/dev/null || true
      docker buildx prune -af --filter "until=2m" &>/dev/null || true
      return 0
    fi
    [[ "$attempt" -eq 3 ]] && return 1
    log "retry $label (attempt $((attempt+1))/3) after transient failure"
    sleep 20
  done
}

LOG_DIR="$OUTPUT_DIR/.bake-logs"
mkdir -p "$LOG_DIR"

log "=== build shared images (agent + model — once, before the per-task loop) ==="
( cd "$EVAL_CONTAINERS_DIR"
  build_and_push "agent" "agents/${AGENT}" "$REBUILD_AGENT" agent "$AGENT"
  build_and_push "model" "models/${GATEWAY_IMAGE}" "$REBUILD_MODEL" model "$GATEWAY_IMAGE" )

bake_task() {  # $1 = task id, $2 = its pre-sanitized log-file key
  local task_id="$1" safe_task="$2"
  local bench_img="benchmarks/${BENCHMARK}-${task_id}"
  local eval_img="evals/${BENCHMARK}-${task_id}--${AGENT}"
  ( cd "$EVAL_CONTAINERS_DIR"
    build_and_push "bench[$task_id]" "$bench_img" "$REBUILD_BENCH" bench "$BENCHMARK" --task-id "$task_id"
    build_and_push "eval[$task_id]"  "$eval_img"  "$REBUILD_EVAL" eval "$BENCHMARK" --agent "$AGENT" --task-id "$task_id" --model "$GATEWAY_IMAGE"
  ) > "$LOG_DIR/$safe_task.log" 2>&1
}

reap() {  # $1 = pid, $2 = task id, $3 = safe task key
  if wait "$1"; then
    log "done $2"
  else
    FAILED=$((FAILED+1))
    FAILED_TASKS+=("$2")
    log "FAILED $2 — see $LOG_DIR/$3.log"
  fi
}

log "=== baking ${#TASK_LIST[@]} $BENCHMARK tasks from $TASK_IDS_FILE for $AGENT, up to $PARALLELISM concurrently ==="
N=0
FAILED=0
PIDS=()
PID_TASKS=()
PID_SAFE_TASKS=()
FAILED_TASKS=()
for TASK in "${TASK_LIST[@]}"; do
  N=$((N+1))
  # Bounded-parallel dispatch, bash-3.2-compatible (no `wait -n`): once at
  # the cap, block on the oldest still-in-flight PID specifically — same
  # FIFO pattern as run-benchmark.sh's per-task fan-out.
  if [[ "${#PIDS[@]}" -ge "$PARALLELISM" ]]; then
    reap "${PIDS[0]}" "${PID_TASKS[0]}" "${PID_SAFE_TASKS[0]}"
    PIDS=("${PIDS[@]:1}")
    PID_TASKS=("${PID_TASKS[@]:1}")
    PID_SAFE_TASKS=("${PID_SAFE_TASKS[@]:1}")
  fi
  SAFE_TASK="$(echo "$TASK" | tr '_' '-')"
  log "[$N/${#TASK_LIST[@]}] dispatched $TASK — log: $LOG_DIR/$SAFE_TASK.log"
  bake_task "$TASK" "$SAFE_TASK" &
  PIDS+=("$!")
  PID_TASKS+=("$TASK")
  PID_SAFE_TASKS+=("$SAFE_TASK")
done

for i in "${!PIDS[@]}"; do
  reap "${PIDS[$i]}" "${PID_TASKS[$i]}" "${PID_SAFE_TASKS[$i]}"
done

log "=== summary: $(( ${#TASK_LIST[@]} - FAILED ))/${#TASK_LIST[@]} baked ==="
if [[ "$FAILED" -gt 0 ]]; then
  log "failed tasks:"
  printf '  %s\n' "${FAILED_TASKS[@]}"
  exit 1
fi
