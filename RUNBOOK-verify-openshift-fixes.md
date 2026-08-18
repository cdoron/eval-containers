# Verifying the OpenShift script fixes — step-by-step

This is a test runbook for the PRs implemented this session against
`.bob/design/openshift-implementation-plan.html`. Everything below has
already been run once, live, against the real `eval-containers-b`
namespace on `pokprod001.ete14.res.ibm.com` — this doc is for you to
re-run and confirm independently. Examples use our real target
combo — benchmark `swe-bench`, agent `swe-agent`, model
`gcp/gemini-3.5-flash-lite` (via IBM's `ete-litellm` OpenAI-compatible
endpoint) — rather than the throwaway combo used while developing the
fixes, except where noted.

## What changed (all on `work-branch`, none merged upstream yet)

| # | Change | File(s) |
|---|--------|---------|
| 1 | Job name sanitized for task ids with `_` (both the chart's `metadata.name` and `run.sh`'s Helm release name) | `containers/benchmarks/_chart/templates/job.yaml`, `deploy/oc/run.sh` |
| 3 | `run.sh` auto-detects per-task benchmarks from the bench image's `eval.benchmark.env` label, sets `perTask=true` automatically — **only works with `--builder oc` against the internal registry; see known gap 5** | `deploy/oc/run.sh` |
| 4 | `GOSU_IMAGE`'s bake default no longer requires `core/gosu` on a fresh registry | `containers/core/combination.docker-bake.hcl` |
| 5 | New `deploy/oc/bootstrap.sh` — idempotent namespace/SCC/PVC/pull-secret setup | `deploy/oc/bootstrap.sh` (new) |
| 6 | `--flat-images {true,false}` flag, replacing a hardcoded `true` | `deploy/oc/run.sh` |
| 7 | `--build-mode external` — build+push locally instead of `--builder oc`, for clusters with no internal registry (this cluster) | `deploy/oc/run.sh` |
| 7b | `--platform` flag on `eval-containers build` — fixes silent wrong-architecture builds on Apple Silicon | `cli/src/build.rs` |

**On hold, not included:** PR 2 (`--model-api` flag), and a `--timeout`
flag (blocked on a separate chart bug — presets always win over `--set`
for any key they declare, so `--timeout` would silently no-op for any
benchmark whose preset sets `timeout`, including `swe-bench`). See
"Known gaps" below for what this means for you concretely.

## Known gaps — read before testing

1. **`EVAL_MODEL_API` still needs a manual patch.** The `--model-api` flag
   (A6) is on hold — its documented failure didn't reproduce live against
   the current `litellm` image/endpoint, so it wasn't shipped this
   session. Routing `gcp/gemini-3.5-flash-lite` through `litellm` against
   a plain OpenAI-compatible endpoint (this cluster's `ete-litellm...`) may
   still need `EVAL_MODEL_API: "openai"` hand-added to the rendered Job's
   gateway `env:` block before `oc apply` — every example below that uses
   the real gemini model includes this step explicitly.

2. **`--model` and `--eval-model` don't do what you might expect.**
   `run.sh --model X` sets **both** the chart's `gatewayImage` (which
   proxy binary — `bifrost`/`litellm`/a pinned combo) and the gateway's
   `EVAL_MODEL` env var to the **same** value `X`. Separately,
   `--eval-model`'s value is threaded to a chart key (`evalModel`) that
   **no template in the chart reads** — confirmed by grep, dead code
   today. So there is no way to say "use the `litellm` gateway, but route
   to `gcp/gemini-3.5-flash-lite`" through `run.sh`'s flags alone — every
   example below that needs a real model render+edits the YAML by hand
   for this reason (`gatewayImage=litellm` separately from
   `model=gcp/gemini-3.5-flash-lite`), the same manual pattern the
   original exploration used. Pre-existing gap, not introduced or fixed
   by any PR this session.

3. **`run.sh`'s build step never threads `--task-id`.** For a per-task
   benchmark (SWE-bench and similar), `run.sh` — in either build mode —
   builds the *generic* bench/eval bake targets, not a specific task's
   image; it has never supported building a real per-task instance image.
   For SWE-bench, build the task-specific images with the CLI directly
   first (shown below), then use `run.sh --no-build` for render/apply/
   watch. AppWorld (shared-env) is unaffected — `run.sh` builds it fully
   itself.

4. **`--timeout` isn't available.** Held per the note above. If you need
   to raise a benchmark's timeout past its preset default (SWE-bench's is
   1800s), you'll need to render with `--dry-run` and hand-edit
   `EVAL_TIMEOUT`/`TIMEOUT`/`activeDeadlineSeconds` in the output, or
   patch the preset file directly — there's no flag for it yet.

5. **PR 3's `perTask` auto-detect doesn't work on this cluster, confirmed
   live.** It queries `oc get istag` (`run.sh:105-108`) — an OpenShift
   *internal-registry* object. `--build-mode external` (ICR, this
   cluster's only viable mode — see Phase 4 of
   `README-Openshift-tested-exploration.md`) never creates any, so the
   query always comes back empty; the check is also skipped outright
   whenever `--dry-run` is passed (`run.sh:105`), which every render in
   this doc uses. Net effect: for *every* SWE-bench example below,
   auto-detect silently leaves `perTask` at its `false` default, the
   runner image renders as the shared-env-shaped
   `evals/swe-bench--swe-agent:latest` (doesn't exist on ICR), and the
   Job applies cleanly but the pod sits in `ImagePullBackOff` forever —
   no error at apply time, no obvious signal beyond `oc get pods`.
   **Always pass `--per-task` explicitly** for SWE-bench renders on this
   cluster (`run.sh`'s override flag, `run.sh:23`) — every SWE-bench
   command below now does.

## Prerequisites

```bash
cargo build --release
export PATH="$(pwd)/target/release:$PATH"   # or rely on run.sh's own
                                             # target/release auto-detect
```

Confirm you're pointed at the right cluster/namespace:
```bash
oc whoami && oc project eval-containers-b
```

## Test 1 — `bootstrap.sh` (idempotent, safe to re-run any time)

Since the namespace already has everything set up, this should report
"exists" / "already granted" for every step and exit non-zero only at
the `eval-secrets` check (which is intentionally never auto-created):

```bash
./deploy/oc/bootstrap.sh \
  --namespace eval-containers-b \
  --storage-class ibm-spectrum-scale-fileset \
  --registry-mode external \
  --registry-server icr.io \
  --registry-username iamapikey \
  --yes
```

Expect:
```
[bootstrap] namespace eval-containers-b exists
[bootstrap] anyuid SCC already granted
[bootstrap] eval-output-pvc exists (storageClassName=ibm-spectrum-scale-fileset)
[bootstrap] pull secret icr-io-pull-secret ready, linked to anyuid-sa
[bootstrap] eval-secrets found
[bootstrap] bootstrap complete for namespace eval-containers-b
```
(If it instead creates a *new* pull secret named `icr-io-pull-secret`
rather than reusing the existing `icr-pull-secret`, that's expected —
they're just different names for the same kind of secret; harmless to
have both, or delete the new one afterward with `oc delete secret
icr-io-pull-secret -n eval-containers-b`.)

## Test 2 — job-name sanitize + build-mode external (SWE-bench)

Reuses the SWE-bench per-task images already built and pushed to ICR by
the prior exploration (`benchmarks/swe-bench-sympy__sympy-24661`,
`agents/swe-agent`, `models/litellm`, `evals/swe-bench-sympy__sympy-24661--swe-agent`)
— per known gap 3, `run.sh` can't build these itself, so this test uses
`--no-build` to exercise render/apply/watch only, against a *real*
underscore-bearing per-task task id (the exact case PR 1 fixed), routed
to the real gemini model (gap 1/2's manual patch, since this is the real
model, not a placeholder):

**`--per-task` is required, not optional, here — PR 3's auto-detect
does not work on this cluster.** Confirmed live: it queries `oc get
istag` (`run.sh:105-108`), an OpenShift *internal-registry* object.
This cluster has none — `oc get istag -n eval-containers-b` returns "No
resources found" under `--build-mode external` (ICR), and the check is
also skipped outright whenever `--dry-run` is passed (`run.sh:105`),
which every render in this doc uses. Omitting `--per-task` renders the
runner image as `evals/swe-bench--swe-agent:latest` (shared-env-shaped,
doesn't exist on ICR) instead of the real per-task image — the Job
applies without error but the pod sits in `ImagePullBackOff` forever.
Use the explicit override (`run.sh:23`) instead:

```bash
./deploy/oc/run.sh \
  --benchmark swe-bench --agent swe-agent --model litellm \
  --task sympy__sympy-24661 --per-task \
  --namespace eval-containers-b \
  --registry icr.io/tir-advisor-eval-containers \
  --build-mode external --no-build --dry-run > swe-bench-job.yaml

# gap 2: --model litellm set gatewayImage correctly but also set
# EVAL_MODEL=litellm (wrong) on BOTH the gateway's and the runner's env
# blocks — they render byte-identical before this patch (the runner's is
# just the last "/"-split segment, and "litellm" has no "/"), so the sed
# below is scoped to only the gateway container's env block (between its
# "name: gateway" line and the runner's "containers:" line) to avoid also
# overwriting the runner's own EVAL_MODEL. Also adds (gap 1) the
# wire-protocol override so litellm doesn't try Gemini's native SDK path
# against this OpenAI-compatible endpoint:
sed -i '' '/name: gateway$/,/^      containers:/ s/value: "litellm"/value: "gcp\/gemini-3.5-flash-lite"/' swe-bench-job.yaml
sed -i '' '/name: gateway$/,/^      containers:/ { /EVAL_MODEL,.*gcp\/gemini/a\
            - { name: EVAL_MODEL_API,              value: "openai" }
}' swe-bench-job.yaml

oc apply -n eval-containers-b -f swe-bench-job.yaml
```

Before PR 1, this would fail at the `helm template` step with a Helm
release-name validation error. Before PR 3, the runner image would
silently resolve to the wrong (shared-env-shaped) name. Confirm both are
fixed:
```bash
oc get job -n eval-containers-b | grep swe-bench   # name uses "sympy--sympy", not "sympy__sympy"
oc get job swe-bench-swe-agent-task-sympy--sympy-24661 -n eval-containers-b \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
# expect: .../evals/swe-bench-sympy__sympy-24661--swe-agent:latest (per-task shape)
```
Watch it to completion (`run.sh --watch`'s own poll loop, run by hand
since we applied manually above):
```bash
JOB=swe-bench-swe-agent-task-sympy--sympy-24661
# oc wait can't OR two conditions — `--for=complete --for=failed` only
# waits on the second (failed), so it hangs on a successful job. Poll
# instead (same pattern run.sh's own --watch uses, run.sh:147-153):
for _ in $(seq 1 1200); do  # ~40m at 2s/iter
  st=$(oc get job "$JOB" -n eval-containers-b -o jsonpath='{.status.conditions[*].type}' 2>/dev/null)
  [[ "$st" == *Complete* || "$st" == *Failed* ]] && break
  sleep 2
done
oc get job "$JOB" -n eval-containers-b
oc logs -n eval-containers-b -l job-name="$JOB" -c gateway --tail=5
# expect 200 OK entries, not a repeat of the :cachedContents 404 — confirms the manual patch worked
```
Given SWE-bench's 30-minute internal `EVAL_TIMEOUT` (known gap 4 — no
way to raise it yet), expect `exit_code: 124` / `reward: 0` on this
model, same genuine timeout outcome as the original exploration — not an
infrastructure failure.

Clean up: `oc delete job swe-bench-swe-agent-task-sympy--sympy-24661 -n eval-containers-b`.

## Test 3 — `--platform` on the CLI directly (optional, only if on Apple Silicon)

```bash
target/release/eval-containers --registry icr.io/tir-advisor-eval-containers \
  build agent swe-agent --platform linux/amd64 --builder default
docker pull icr.io/tir-advisor-eval-containers/agents/swe-agent:latest
docker image inspect icr.io/tir-advisor-eval-containers/agents/swe-agent:latest --format '{{.Architecture}}'
# expect: amd64
```
(Without `--platform`, the same command on an arm64 Mac silently
produces `arm64` — the bug this flag fixes.)

---

## Full deploy-and-run walkthrough — from a clean checkout to one completed task

This is the "what does a user actually need to do" sequence — everything
from prerequisites through a fetched, reported result, for one real task
against the real gemini model. Two variants: **AppWorld/terminus-2**
(shared-env, no per-task build gap, genuinely the simpler of the two —
recommended first) and **SWE-bench/swe-agent** (per-task, needs the extra
manual build step from gap 3). Both need gap 1/2's manual model patch.

### 0. Prerequisites (once)

```bash
cargo build --release
export PATH="$(pwd)/target/release:$PATH"
oc login <cluster>                       # if not already
ibmcloud login --sso && ibmcloud cr login --client docker   # ICR push auth
```

### 1. Namespace prereqs

```bash
./deploy/oc/bootstrap.sh \
  --namespace eval-containers-b --storage-class ibm-spectrum-scale-fileset \
  --registry-mode external --registry-server icr.io --registry-username iamapikey \
  --yes
```
If it stops at `eval-secrets not found`, create it by hand once (key
material never passes through any script):
```bash
oc create secret generic eval-secrets -n eval-containers-b \
  --from-literal=OPENAI_API_KEY=<key> \
  --from-literal=OPENAI_API_BASE=<https://ete-litellm... endpoint>
```

### 2A. AppWorld / terminus-2 (recommended — simpler, shared-env)

Build + push (skips automatically if already pushed from the prior
exploration):
```bash
./deploy/oc/run.sh \
  --benchmark appworld --agent terminus-2 --model litellm --dataset-size 1 \
  --namespace eval-containers-b \
  --registry icr.io/tir-advisor-eval-containers \
  --build-mode external \
  --no-run
```
Render, apply the gap-1/2 model patch, apply for real:
```bash
./deploy/oc/run.sh \
  --benchmark appworld --agent terminus-2 --model litellm --dataset-size 1 \
  --namespace eval-containers-b \
  --registry icr.io/tir-advisor-eval-containers \
  --build-mode external --no-build --dry-run > appworld-job.yaml

# same scoping caveat as Test 2 above — restrict to the gateway's own
# env block so the runner's identically-rendered EVAL_MODEL line is untouched
sed -i '' '/name: gateway$/,/^      containers:/ s/value: "litellm"/value: "gcp\/gemini-3.5-flash-lite"/' appworld-job.yaml
sed -i '' '/name: gateway$/,/^      containers:/ { /EVAL_MODEL,.*gcp\/gemini/a\
            - { name: EVAL_MODEL_API,              value: "openai" }
}' appworld-job.yaml

oc apply -n eval-containers-b -f appworld-job.yaml
# oc wait can't OR two conditions — see run.sh:147-153 for why this
# polls instead of using `oc wait --for=complete --for=failed`
for _ in $(seq 1 450); do  # ~15m at 2s/iter
  st=$(oc get job appworld-terminus-2 -n eval-containers-b -o jsonpath='{.status.conditions[*].type}' 2>/dev/null)
  [[ "$st" == *Complete* || "$st" == *Failed* ]] && break
  sleep 2
done
oc get job appworld-terminus-2 -n eval-containers-b
```

### 2B. SWE-bench / swe-agent (per-task — needs a manual build first, gap 3)

Skip this if you did 2A. Build the per-task images yourself (the exact
task id below already exists from the prior exploration and will be
skipped if so — substitute any SWE-bench Verified instance id to build a
new one):
```bash
TASK=sympy__sympy-24661
eval-containers --registry icr.io/tir-advisor-eval-containers build bench swe-bench --task-id "$TASK" --platform linux/amd64
eval-containers --registry icr.io/tir-advisor-eval-containers push  bench swe-bench --task-id "$TASK"
eval-containers --registry icr.io/tir-advisor-eval-containers build agent swe-agent --platform linux/amd64
eval-containers --registry icr.io/tir-advisor-eval-containers push  agent swe-agent
eval-containers --registry icr.io/tir-advisor-eval-containers build model litellm --platform linux/amd64
eval-containers --registry icr.io/tir-advisor-eval-containers push  model litellm
eval-containers --registry icr.io/tir-advisor-eval-containers build eval swe-bench --agent swe-agent --task-id "$TASK" --model litellm --platform linux/amd64
eval-containers --registry icr.io/tir-advisor-eval-containers push  eval swe-bench --agent swe-agent --task-id "$TASK"
```
Then render/patch/apply exactly as in Test 2 above, with `--task "$TASK"`
instead of the hardcoded id — spelled out in full below since `$TASK`
also has to flow through into the job name for the watch/logs step
(`run.sh` sanitizes it via `tr '_' '-'`, `run.sh:119`).

**Re-declare `TASK` here even though it was set above** — each fenced
code block in this doc is liable to run as its own shell invocation
(true of tool-driven bash, and an easy trap even in a plain terminal
across separate panes/sessions), so a variable set in an earlier block
isn't guaranteed to survive. Skipping this produces `SAFE_TASK=""` and
a malformed `JOB="swe-bench-swe-agent-task-"` — `oc` will reject the
`-l job-name=...` selector with "Invalid value" rather than silently
using the wrong job:

```bash
TASK=sympy__sympy-24661
SAFE_TASK="$(echo "$TASK" | tr '_' '-')"
JOB="swe-bench-swe-agent-task-${SAFE_TASK}"

./deploy/oc/run.sh \
  --benchmark swe-bench --agent swe-agent --model litellm \
  --task "$TASK" --per-task \
  --namespace eval-containers-b \
  --registry icr.io/tir-advisor-eval-containers \
  --build-mode external --no-build --dry-run > swe-bench-job.yaml

# gap 2 patch, same scoping caveat as Test 2 (restrict to the gateway's
# own env block so the runner's identically-rendered EVAL_MODEL line is
# untouched):
sed -i '' '/name: gateway$/,/^      containers:/ s/value: "litellm"/value: "gcp\/gemini-3.5-flash-lite"/' swe-bench-job.yaml
sed -i '' '/name: gateway$/,/^      containers:/ { /EVAL_MODEL,.*gcp\/gemini/a\
            - { name: EVAL_MODEL_API,              value: "openai" }
}' swe-bench-job.yaml

oc apply -n eval-containers-b -f swe-bench-job.yaml

# oc wait can't OR two conditions — see run.sh:147-153
for _ in $(seq 1 1200); do  # ~40m at 2s/iter
  st=$(oc get job "$JOB" -n eval-containers-b -o jsonpath='{.status.conditions[*].type}' 2>/dev/null)
  [[ "$st" == *Complete* || "$st" == *Failed* ]] && break
  sleep 2
done
oc get job "$JOB" -n eval-containers-b
oc logs -n eval-containers-b -l job-name="$JOB" -c gateway --tail=5
# expect 200 OK entries, not a repeat of the :cachedContents 404
```

**Note (also applies to Test 2 above):** the render command must include
`--build-mode external`. `run.sh` defaults `BUILD_MODE=oc`, which in turn
defaults `flatImages=true` (`run.sh:39`) — and `flatImages=true` makes the
chart compose *flat* ImageStream names (no slashes), not the nested
`registry/evals/<name>:tag` paths these images were actually pushed to
and that the "expect" outputs above assume. Test 2's command as written
is missing this flag; add `--build-mode external` there too before
running it.

### 3A. Watch, then fetch + report — AppWorld (2A)

```bash
# oc wait can't OR two conditions — see run.sh:147-153
for _ in $(seq 1 450); do  # ~15m at 2s/iter
  st=$(oc get job appworld-terminus-2 -n eval-containers-b -o jsonpath='{.status.conditions[*].type}' 2>/dev/null)
  [[ "$st" == *Complete* || "$st" == *Failed* ]] && break
  sleep 2
done
oc get job appworld-terminus-2 -n eval-containers-b

./deploy/oc/fetch.sh --benchmark appworld --agent terminus-2 \
  --model litellm --namespace eval-containers-b

eval-containers report output/appworld/terminus-2/litellm/     # A7's depth-cap workaround — point one level below output/
```
**Note:** use `--model litellm` here, not `gcp/gemini-3.5-flash-lite`.
`outputSubPath` is computed by `run.sh` at render time from the
`--model` flag you passed the CLI (`litellm`, needed to pick the right
`gatewayImage`) — the gap-1/2 `sed` patch only rewrites the gateway/
runner env blocks, it never touches `outputSubPath`. So results
actually land on the PVC under `runs/appworld/terminus-2/litellm/...`,
not `.../gcp/gemini-3.5-flash-lite/...`. Fetching with the real model
name silently succeeds (`oc cp` of a nonexistent path exits 0) and
leaves you with an empty local directory.
Expect a real `REWARD`/`PASS`/`FAIL` row with `TRACES OK`. AppWorld's
single task previously completed in ~4.5 minutes with a genuine
`reward: 1.0` in the original exploration — a good sign if you see the
same.

Clean up: `oc delete job appworld-terminus-2 -n eval-containers-b`.

### 3A-alt. Re-running AppWorld with a longer timeout (900s)

AppWorld's chart default is `EVAL_TIMEOUT=300`/`TIMEOUT=300`
(`values.yaml:57`, no `presets/appworld.yaml` to override it) — tight
enough that ordinary per-call model latency variance can tip a run from
a pass into `exit_code: 124` (confirmed live: one run finished in 39
calls/269s with `reward: 1.0`, a re-run of the *same* task hit 39 calls
but ran past 300s and got killed by `run-agent`'s `timeout -k 30
"${TIMEOUT:-300}"` wrapper — `containers/core/runner/run-agent:35`).
This is a genuine "ran out of time" outcome, the same category as
SWE-bench's documented 30-minute timeouts — not a bug, and not the
`asciinema` warning in `agent/stderr.log` (that line is benign; it
appears in passing runs too).

`run.sh` has no `--timeout` flag and no generic `--set` passthrough, so
raise it by invoking `helm template` directly — same approach as the
tested exploration's Phase 9, replicating the same `--set` values
`run.sh --build-mode external` would have used, plus `timeout=900`:

```bash
helm template appworld-terminus-2 containers/benchmarks/_chart \
  -f deploy/values-openshift.yaml \
  --set benchmark=appworld --set agent=terminus-2 --set datasetSize=1 \
  --set model=litellm --set gatewayImage=litellm \
  --set registry=icr.io/tir-advisor-eval-containers --set flatImages=false \
  --set outputVolume.persistentVolumeClaim.claimName=eval-output-pvc \
  --set outputSubPath=runs/appworld/terminus-2/litellm \
  --set timeout=900 \
  > appworld-job-900.yaml

# same gap-1/2 patch as 2A — restrict to the gateway's own env block
sed -i '' '/name: gateway$/,/^      containers:/ s/value: "litellm"/value: "gcp\/gemini-3.5-flash-lite"/' appworld-job-900.yaml
sed -i '' '/name: gateway$/,/^      containers:/ { /EVAL_MODEL,.*gcp\/gemini/a\
            - { name: EVAL_MODEL_API,              value: "openai" }
}' appworld-job-900.yaml

oc delete job appworld-terminus-2 -n eval-containers-b --ignore-not-found
oc apply -n eval-containers-b -f appworld-job-900.yaml

# oc wait can't OR two conditions — see run.sh:147-153. 900s timeout + grace,
# so poll for longer than 3A's 15m loop.
for _ in $(seq 1 600); do  # ~20m at 2s/iter
  st=$(oc get job appworld-terminus-2 -n eval-containers-b -o jsonpath='{.status.conditions[*].type}' 2>/dev/null)
  [[ "$st" == *Complete* || "$st" == *Failed* ]] && break
  sleep 2
done
oc get job appworld-terminus-2 -n eval-containers-b

./deploy/oc/fetch.sh --benchmark appworld --agent terminus-2 \
  --model litellm --namespace eval-containers-b
eval-containers report output/appworld/terminus-2/litellm/
```
Verify the timeout actually took before waiting the full 20 minutes —
check the rendered YAML has `EVAL_TIMEOUT`/`TIMEOUT` = `"900"` and
`activeDeadlineSeconds` ≈ `900 + deadlineGrace`:
```bash
grep -E 'EVAL_TIMEOUT|TIMEOUT,|activeDeadlineSeconds' appworld-job-900.yaml
```

Clean up: `oc delete job appworld-terminus-2 -n eval-containers-b`.

### 3B. Watch, then fetch + report — SWE-bench (2B)

`$TASK`/`$JOB` carry over from 2B above (re-set them here if this is a
new shell):
```bash
TASK=sympy__sympy-24661
SAFE_TASK="$(echo "$TASK" | tr '_' '-')"
JOB="swe-bench-swe-agent-task-${SAFE_TASK}"
```
The `oc wait`/`oc logs` steps already ran at the end of 2B — this picks
up from fetch + report:
```bash
oc get job "$JOB" -n eval-containers-b

./deploy/oc/fetch.sh --benchmark swe-bench --agent swe-agent \
  --model litellm --namespace eval-containers-b

eval-containers report output/swe-bench/swe-agent/litellm/     # A7's depth-cap workaround — point one level below output/
```
Same `--model litellm` note as 3A — `outputSubPath` follows the CLI
flag, not the real model patched into the YAML.
SWE-bench is much slower (up to the 30-minute internal timeout) and
both prior real attempts hit that timeout rather than a pass — expect
`exit_code: 124` / `reward: 0`, not an infra failure, just a slow model
on a hard task.

Clean up: `oc delete job "$JOB" -n eval-containers-b`.

## If any of these fail differently than described above

Stop and report back with the actual output — don't assume the fix is
wrong without comparing to what's written here, but also don't assume
it's right just because *something* happened. The whole point of this
runbook is an independent second confirmation.
