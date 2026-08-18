# OpenShift deployment — tested runbook

This file is a running log of every step that has been **actually run and
confirmed working** while standing up `eval-containers` on the shared
OpenShift cluster to run SWE-bench Verified via `swe-agent`. Steps are
appended as they're confirmed, in order, **including dead ends and
corrections** — this is a trial-and-error narrative, not a cleaned-up
procedure. See `CHANGE-OPENSHIFT.md` for the separate log of every
deviation/fix discovered along the way, organized by category.

## Repo / environment context

- Local checkout: this repo, branch `work-branch`. `git remote -v` → `origin`
  is `git@github.com:cdoron/eval-containers.git` (a fork) — **not**
  `Exgentic/eval-containers` (the project referenced throughout as
  "upstream"). No `upstream` remote is configured. See `CHANGE-OPENSHIFT.md`'s
  "Selective PR strategy" for the actual git workflow this implies.
- Cluster: `pokprod001.ete14.res.ibm.com` (OCP 4.19.19 / k8s 1.32.9), an
  internal IBM Research OpenShift cluster — not IBM Cloud VPC/ROKS, and its
  internal image registry is administratively disabled (see Phase 4 below).
- Namespace: `eval-containers-b`.
- Registry: `icr.io/tir-advisor-eval-containers` (IBM Cloud Container
  Registry — external, since the cluster's internal one is unusable).
- Tested from: macOS (Darwin arm64), Rancher Desktop (Docker `29.5.3-rd`).

## Prerequisites (consolidated from all phases below)

| Tool | Why | Confirmed version/state this session |
|---|---|---|
| `cargo`/Rust toolchain | build the `eval-containers` CLI (Phase 0) | already installed |
| Docker Engine + `buildx` | build agent/benchmark/eval/gateway images | Rancher Desktop, Docker `29.5.3-rd` |
| `oc` | cluster access, all `apply`/`get`/`logs`/`cp` operations | logged in via `oc login`, OCP 4.19.19 |
| `helm` | render the Job from `containers/benchmarks/_chart` | `v4.2.1` confirmed working |
| `ibmcloud` CLI + `container-registry` plugin | ICR login (`ibmcloud cr ...`), IAM API key creation | already installed, `2.38.0` |
| `jq` | extracting the IAM API key value from `ibmcloud iam api-key-create` JSON output | used once, assumed present |

Not needed on this cluster (the internal-registry / `--builder oc` path was
tried and abandoned — see Phase 4): no dependency on OpenShift's own image
registry, no `BuildConfig`/`oc start-build` usage in the working path.

## Phase 0 — Build the CLI locally

```bash
cargo build --release
```
Confirmed: builds cleanly in ~11s, binary at `target/release/eval-containers`.

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/target/release/eval-containers" ~/.local/bin/eval-containers
```
Confirmed: `~/.local/bin` was already on `PATH`; symlink resolves.

```bash
eval-containers --help
```
Confirmed: prints the subcommand list (`build`, `push`, `list`, `images`,
`inspect`, `prune`, `run`, `oracle`, `report`, `gen-bake`).

```bash
eval-containers list benchmarks
eval-containers list agents
eval-containers list models
```
**Gotcha (not a bug):** `list` wraps local `docker images` — it only shows
images already present in the local Docker daemon, not the source tree's
benchmark/agent definitions. With nothing built/pulled yet it correctly
printed `no benchmark image found` / `no agent images found`. `list models`
showed `ghcr.io/exgentic/models/litellm:latest` because that image happened
to already be present locally (pulled in an earlier session on this machine)
— not evidence of anything we did in this phase.
Confirmed as expected behavior by reading `cli/src/list.rs`
(`get_images` = `docker images --format ... {registry}/{kind}/*`).
`docker version` also confirmed the local Docker daemon (Rancher Desktop) is
reachable.

**Takeaway:** to confirm `swe-bench`/`swe-agent` exist as buildable
components before building anything, look at the source tree
(`containers/benchmarks/swe-bench/`, `containers/agents/swe-agent/`), not
`eval-containers list`.

## Phase 1 — Cluster + namespace

```bash
oc whoami
oc whoami --show-server
oc version
```
Confirmed: logged in as `BRUNOW@il.ibm.com` against
`https://api.pokprod001.ete14.res.ibm.com:6443`, server `OCP 4.19.19` /
Kubernetes `v1.32.9` — comfortably above every version gate in
`deploy/oc/README.md` (Indexed Jobs need ≥4.11, `--retry` needs ≥4.16; not
that we need either for a single-task debug run).

```bash
oc get ns exgentic-ns
```
Confirmed: this namespace **already exists** (36 days old) — do not use it.

```bash
oc get sa,pvc,secret,jobs,pods -n exgentic-ns
```
Confirmed: it already hosts an unrelated service account
(`inference-perf-runner`) — i.e. it belongs to someone else's work, not ours.
**Decision (with Bruno): revert to the originally-requested namespace,
`eval-containers-b`**, created fresh rather than reusing a namespace that
turned out to not be ours. This is why the plan's earlier "just reuse
exgentic-ns" simplification was abandoned — logged as a Type B change in
`CHANGE-OPENSHIFT.md`.

```bash
oc get ns eval-containers-b   # confirmed NotFound first — didn't exist yet
```

⚠️ Cluster-wide checkpoint taken here: confirmed with Bruno before creating a
new namespace on the shared cluster.

```bash
oc new-project eval-containers-b
```
Confirmed: created, and `oc new-project` also switches the current context to
it (`oc project` → "Using project eval-containers-b...").

```bash
oc get sa -n eval-containers-b
```
Confirmed: only the three default OpenShift service accounts
(`builder`, `default`, `deployer`) — a clean namespace, ready for Phase 2.

## Phase 2 — Namespace prerequisites

```bash
oc apply -f deploy/openshift-service-account.yaml -n eval-containers-b
```
Confirmed: `serviceaccount/anyuid-sa created`. Note the file itself carries no
namespace — it applies to whatever the current context/`-n` is.

⚠️ Cluster-wide checkpoint taken here (SCC grant): confirmed with Bruno first.

```bash
oc adm policy add-scc-to-user anyuid -z anyuid-sa -n eval-containers-b
```
Confirmed: `clusterrole.rbac.authorization.k8s.io/system:openshift:scc:anyuid
added: "anyuid-sa"`. Verified blast radius is namespace-scoped only:

```bash
oc get rolebinding -n eval-containers-b | grep scc     # → a RoleBinding, in-namespace
oc get clusterrolebinding | grep anyuid-sa              # → none (no new ClusterRoleBinding)
```

**PVC.** `oc get storageclass` showed the committed
`deploy/eval-output-pvc.yaml`'s `storageClassName:
ibmc-vpc-file-retain-1000-iops` does **not** exist on this cluster (it's an
IBM-Cloud-VPC-specific class; this cluster has `ibm-spectrum-scale-fileset`
(default), `nfs-client-pokprod`, plus a couple of `no-provisioner` classes
unsuitable for dynamic RWX). Tested a patched manifest (namespace +
storageClass swapped, applied via stdin — the committed repo file itself
was **not** edited yet, pending the Phase 9 write-up):

```bash
cat <<'EOF' | oc apply -n eval-containers-b -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: eval-output-pvc
  namespace: eval-containers-b
spec:
  accessModes: [ReadWriteMany]
  storageClassName: ibm-spectrum-scale-fileset
  resources: { requests: { storage: 20Gi } }
EOF
oc get pvc eval-output-pvc -n eval-containers-b
```
Confirmed: `STATUS Bound`, `ACCESS MODES RWX`, `STORAGECLASS
ibm-spectrum-scale-fileset` — works on the first try with the cluster's
default class.

**Secret.** Bruno ran the `oc create secret generic eval-secrets` command
himself (key never typed into this session). Verified:

```bash
oc get secret eval-secrets -n eval-containers-b               # DATA: 2
oc get secret eval-secrets -n eval-containers-b \
  -o jsonpath='{.data.OPENAI_API_BASE}' | base64 -d           # → https://ete-litellm.ai-models.vpc-int.res.ibm.com
```
Confirmed: 2 keys present, `OPENAI_API_BASE` decodes correctly.
**Caution logged:** the first verification pass dumped the full `.data` map
(both keys, base64-encoded) into the session transcript — base64 is
trivially reversible, so treat that as equivalent to having shown the key in
cleartext once. Only key *presence* should be checked from now on, not a full
`.data` dump. Bruno may want to consider rotating this key.

## Phase 3 — Dry-run render (no apply, no build yet)

```bash
helm template swe-agent-sympy containers/benchmarks/_chart \
  --set benchmark=swe-bench --set agent=swe-agent \
  --set task=sympy__sympy-24661 \
  --set model=gcp/gemini-3.5-flash-lite \
  --set gatewayImage=litellm \
  -f deploy/values-openshift.yaml \
  --set registry=image-registry.openshift-image-registry.svc:5000/eval-containers-b \
  --set flatImages=true \
  --set outputVolume.persistentVolumeClaim.claimName=eval-output-pvc \
  --set outputSubPath=runs/swe-bench/swe-agent/gcp/gemini-3.5-flash-lite/sympy__sympy-24661
```
Confirmed: renders cleanly, no `<no value>`, no errors. Checked specifically:
- gateway container `EVAL_MODEL` = `gcp/gemini-3.5-flash-lite` ✓
- gateway image = `.../eval-containers-b/litellm:latest` (litellm, not the
  chart's default bifrost) ✓
- gateway `OPENAI_API_KEY`/`OPENAI_API_BASE` sourced from `secretKeyRef:
  {name: eval-secrets, ...}` ✓
- `serviceAccountName: anyuid-sa` ✓ (from `deploy/values-openshift.yaml`)
- runner image = `.../eval-containers-b/swe-bench-swe-agent:latest` (flat
  naming worked)
- output volume/subPath match what `deploy/oc/fetch.sh` will look for later

**Watch item, not yet a problem:** `EVAL_TIMEOUT=1800` /
`activeDeadlineSeconds=2400` are the chart defaults — swe-agent runs can be
slow; revisit if Phase 5/6 shows the Job hitting this deadline.

## Phase 4 — Build in-cluster: BLOCKED on the internal registry

```bash
eval-containers build bench swe-bench --task-id sympy__sympy-24661 --builder oc --dry-run
```
Confirmed error: `--builder oc does not support --task-id; per-task variants
use plain docker build (BAKE.md)`. Per `cli/src/build.rs`, per-task **bench**
builds always use plain local `docker build`, never bake/`--builder oc` —
this alone isn't fatal (`build eval --task-id --builder oc` still routes
through `bake`, per the code), so kept investigating rather than stopping
here.

```bash
oc get route -n openshift-image-registry     # No resources found
oc registry info                             # error: the integrated registry has not been configured
oc get svc -n openshift-image-registry       # only image-registry-operator (control loop), no image-registry svc
oc get configs.imageregistry.operator.openshift.io cluster \
  -o jsonpath='{.spec.managementState}'      # → Removed
```
**Confirmed hard blocker (not a capacity issue):** the OpenShift internal
image registry is administratively `Removed` on this cluster — status
condition literally reads "The registry is removed." No service, no route,
no ImageStreamTag backing. This rules out **both** `docker push` to the
internal registry **and** `--builder oc` (its BuildConfig output target is an
`ImageStreamTag`, which requires the same registry).
**Decision needed from Bruno: switch to an external registry** he can get
access to — see `CHANGE-OPENSHIFT.md` for how this is tracked.

## Phase 4 (cont.) — External registry: IBM Cloud Container Registry (ICR)

Bruno provisioned an ICR namespace. Confirmed details (run by Bruno):

```bash
ibmcloud login --sso
ibmcloud target                    # Account: ETE CIL12
ibmcloud cr region-set global      # → registry is icr.io
ibmcloud cr namespace-list         # → tir-advisor-eval-containers
ibmcloud cr login --client docker  # local docker login to icr.io
```
Registry to use for everything from here on: **`icr.io/tir-advisor-eval-containers`**.

**Push access test:**
```bash
docker pull busybox:latest
docker tag busybox:latest icr.io/tir-advisor-eval-containers/push-test:ping
docker push icr.io/tir-advisor-eval-containers/push-test:ping
ibmcloud cr image-rm icr.io/tir-advisor-eval-containers/push-test:ping   # cleanup
```
Confirmed: push succeeds from this laptop.

**Cluster pull access test — first attempt, no pull secret (expected to fail):**
```bash
oc run pull-test --image=icr.io/tir-advisor-eval-containers/push-test:pulltest \
  -n eval-containers-b --restart=Never --command -- sleep 30
```
Confirmed: `ErrImagePull` / `denied: You are not authorized to access the
specified resource` — the cluster has no ICR credentials by default (this is
not an IBM-Cloud-managed/ROKS cluster synced to the same account; it's an
internal IBM Research OpenShift cluster). A pull secret is required.

**Pull secret setup.** Bruno created a dedicated IAM API key himself (never
typed into this session):
```bash
ibmcloud iam api-key-create eval-containers-b-pull \
  -d "pull access for eval-containers-b OpenShift namespace" \
  --output json > ~/icr-pull-key.json
jq -r .apikey ~/icr-pull-key.json > ~/icr-pull-key.txt
```
Then, reading the key only via `$(cat ...)` inside the command (value never
printed to any output):
```bash
oc create secret docker-registry icr-pull-secret \
  -n eval-containers-b \
  --docker-server=icr.io \
  --docker-username=iamapikey \
  --docker-password="$(cat ~/icr-pull-key.txt)" \
  --docker-email=unused@example.com

oc secrets link anyuid-sa icr-pull-secret --for=pull -n eval-containers-b
oc get sa anyuid-sa -n eval-containers-b -o jsonpath='{.imagePullSecrets}'
# → [{"name":"icr-pull-secret"}]
```
**Gotcha:** the first attempt hit a transient `dial tcp ... i/o timeout`
talking to the OpenShift API — retried once, worked. Also, `docker push`
failed once with `unauthorized` because the local `ibmcloud cr login --client
docker` token had expired between sessions — refreshed with `ibmcloud cr
login --client docker` again and the push succeeded.

**Cluster pull access test — second attempt, with the pull secret + SA link:**
```bash
docker tag busybox:latest icr.io/tir-advisor-eval-containers/push-test:pulltest2
docker push icr.io/tir-advisor-eval-containers/push-test:pulltest2
oc run pull-test2 --image=icr.io/tir-advisor-eval-containers/push-test:pulltest2 \
  -n eval-containers-b --restart=Never \
  --overrides='{"spec":{"serviceAccountName":"anyuid-sa"}}' --command -- sleep 30
```
Confirmed via `oc describe pod pull-test2`: `Successfully pulled image` —
the pull secret + SA link works. (The pod then hit `Exec format error`
because the quick test image was an arm64 `busybox`, pulled on this arm64
Mac, run against the cluster's x86_64 nodes — irrelevant to the pull-secret
test itself, and not a concern for real builds, which will target the
correct architecture.) Cleaned up both the test pod and test image
afterward.

## Phase 4 (cont.) — building the real images against ICR

Registry: `icr.io/tir-advisor-eval-containers` (setup above).

**Gotcha, confirmed live (logged as A2 in `CHANGE-OPENSHIFT.md`): building on
this arm64 Mac silently produces arm64 images unless the platform is forced.**
`DOCKER_DEFAULT_PLATFORM=linux/amd64` is ignored by `docker buildx bake`
(tested directly — same env var, same command, image came out `arm64`
regardless). The fix, confirmed working: bypass the CLI's own invocation and
add `--set '*.platform=linux/amd64'` directly to the underlying `docker
buildx bake` call. Checked with `docker image inspect ... --format
'{{.Architecture}}'` after every build from here on.

**1. Per-task bench image** (plain `docker build`, not bake — happened to
build `amd64` correctly on its own, because its Dockerfile hard-pins an
x86_64-only upstream base, forcing emulation regardless of host platform):
```bash
eval-containers --registry icr.io/tir-advisor-eval-containers \
  build bench swe-bench --task-id sympy__sympy-24661
docker image inspect icr.io/tir-advisor-eval-containers/benchmarks/swe-bench-sympy__sympy-24661:latest \
  --format '{{.Architecture}}'                                    # → amd64
docker push icr.io/tir-advisor-eval-containers/benchmarks/swe-bench-sympy__sympy-24661:latest
```

**2. Agent image** (bake-based — hit the platform bug for real):
```bash
# First attempt (wrong): came out arm64 despite DOCKER_DEFAULT_PLATFORM=linux/amd64
# Fix: hand-invoke buildx bake with the platform override (full -f file list
# from `eval-containers build agent swe-agent --dry-run`, plus --set):
docker buildx bake -f containers/docker-bake.hcl -f ... [full file list] \
  --load --set '*.platform=linux/amd64' \
  --set '*.labels.org.opencontainers.image.source=...' \
  agent-swe-agent
docker image inspect icr.io/tir-advisor-eval-containers/agents/swe-agent:latest \
  --format '{{.Architecture}}'                                    # → amd64 (after fix)
docker push icr.io/tir-advisor-eval-containers/agents/swe-agent:latest
```

**3. Combined eval image** — hit a second, separate gotcha (logged as A3):
building `eval` against a **brand-new** registry fails because
`GOSU_IMAGE`'s bake-level default resolves to `${REGISTRY}/core/gosu:latest`
— our registry, which has no `core/gosu` pushed. Fixed by explicitly
overriding it back to the public upstream default:
```bash
docker buildx bake -f ... [eval + swe-bench + swe-agent bake files] \
  --load --set '*.platform=linux/amd64' \
  --set eval.args.BENCHMARK_IMAGE=icr.io/tir-advisor-eval-containers/benchmarks/swe-bench-sympy__sympy-24661:latest \
  --set eval.args.AGENT_IMAGE=icr.io/tir-advisor-eval-containers/agents/swe-agent:latest \
  --set eval.args.GOSU_IMAGE=ghcr.io/exgentic/core/gosu:latest \
  --set eval.tags=icr.io/tir-advisor-eval-containers/evals/swe-bench-sympy__sympy-24661--swe-agent:latest \
  eval
docker image inspect icr.io/tir-advisor-eval-containers/evals/swe-bench-sympy__sympy-24661--swe-agent:latest \
  --format '{{.Architecture}}'                                    # → amd64
docker push icr.io/tir-advisor-eval-containers/evals/swe-bench-sympy__sympy-24661--swe-agent:latest
```

**4. `flatImages` correction:** Phase 3's render used `--set
flatImages=true` because the docs' OpenShift examples do — but that exists
only to work around the *internal* registry's no-slashes ImageStream naming
rule. ICR supports normal nested paths, same as the CLI's default naming, so
from here on **`flatImages` is left unset (default `false`)** — the images
above are already at the paths the chart expects without any renaming.

**5. Gateway (litellm) + otelcol images** — also bake-based, both hit the
same platform issue, same fix:
```bash
docker buildx bake -f ... [model-litellm bake files] \
  --load --set '*.platform=linux/amd64' --set '*.labels...=...' model-litellm
docker image inspect icr.io/tir-advisor-eval-containers/models/litellm:latest \
  --format '{{.Architecture}}'                                    # → amd64
docker push icr.io/tir-advisor-eval-containers/models/litellm:latest

docker buildx bake -f containers/docker-bake.hcl -f containers/core/otel/docker-bake.hcl \
  --load --set '*.platform=linux/amd64' --set '*.labels...=...' otel
docker image inspect icr.io/tir-advisor-eval-containers/core/otel:latest \
  --format '{{.Architecture}}'                                    # → amd64
docker push icr.io/tir-advisor-eval-containers/core/otel:latest
```

All five images now on ICR, all confirmed `amd64`:
- `benchmarks/swe-bench-sympy__sympy-24661:latest`
- `agents/swe-agent:latest`
- `evals/swe-bench-sympy__sympy-24661--swe-agent:latest`
- `models/litellm:latest`
- `core/otel:latest`

**Gotcha #3 (logged as A4 in `CHANGE-OPENSHIFT.md`, systemic — affects every
per-task benchmark, not just swe-bench):** the corrected re-render (registry
= ICR, no `flatImages`) initially still came out wrong — the runner image
resolved to `evals/swe-bench--swe-agent:latest` (the *shared-env* naming),
not the per-task name we actually built and pushed
(`evals/swe-bench-sympy__sympy-24661--swe-agent:latest`). Root cause:
`presets/swe-bench.yaml` doesn't set `perTask: true`, and neither does any
other per-task benchmark's preset (checked all 8). Fixed by adding `--set
perTask=true` explicitly to the `helm template` command:

```bash
helm template swe-agent-sympy containers/benchmarks/_chart \
  --set benchmark=swe-bench --set agent=swe-agent \
  --set task=sympy__sympy-24661 \
  --set perTask=true \
  --set model=gcp/gemini-3.5-flash-lite \
  --set gatewayImage=litellm \
  -f deploy/values-openshift.yaml \
  --set registry=icr.io/tir-advisor-eval-containers \
  --set outputVolume.persistentVolumeClaim.claimName=eval-output-pvc \
  --set outputSubPath=runs/swe-bench/swe-agent/gcp/gemini-3.5-flash-lite/sympy__sympy-24661
```
Confirmed: runner image now correctly
`icr.io/tir-advisor-eval-containers/evals/swe-bench-sympy__sympy-24661--swe-agent:latest`
— matches what's actually on ICR. Full rendered YAML also re-checked:
gateway `EVAL_MODEL`, `eval-secrets` sourcing, `serviceAccountName:
anyuid-sa`, and volume/subPath all still correct.

## Phase 5 — Apply the sympy Job

**Gotcha #4 (logged as A5 in `CHANGE-OPENSHIFT.md`):** `oc apply` on the
rendered YAML from Phase 4 rejected the Job outright:
```
metadata.name: Invalid value: "swe-bench-swe-agent-task-sympy__sympy-24661":
a lowercase RFC 1123 subdomain must consist of ...
```
Kubernetes object names forbid `_`, but SWE-bench instance IDs contain `__`.
Not caught by `helm template` (no API-server validation at render time).
Patched only the `metadata.name` line in the rendered file (labels keep the
real task id with underscores — label *values* allow underscores, only
object *names* don't):
```bash
sed -i '' 's/name: swe-bench-swe-agent-task-sympy__sympy-24661/name: swe-bench-swe-agent-task-sympy-sympy-24661/' sympy-job.yaml
oc apply -n eval-containers-b -f sympy-job.yaml
# → job.batch/swe-bench-swe-agent-task-sympy-sympy-24661 created
```

**Progress so far** (`oc describe pod`):
- `otelcol` init container: pulled `icr.io/tir-advisor-eval-containers/core/otel:latest` in 2.3s, started — confirms the ICR pull secret works for a real (non-test) image too.
- `gateway` (litellm) init container: pulled `icr.io/tir-advisor-eval-containers/models/litellm:latest` in ~17s, started (one transient startup-probe failure before it came up, self-resolved).
- `runner`: pulling `icr.io/tir-advisor-eval-containers/evals/swe-bench-sympy__sympy-24661--swe-agent:latest` (large image — swebench + full Python env).

Job reached `Complete` (exit 0) in ~40s — suspiciously fast for a real
LLM-driven coding task, so checked logs before trusting it:
```bash
oc logs <pod> -n eval-containers-b --all-containers=true --prefix=true
```

**Gotcha #5 (logged as A6 in `CHANGE-OPENSHIFT.md`, framework-wide, not just
OpenShift):** the gateway (litellm) logs showed every completion request
404'd:
```
litellm.NotFoundError: GeminiException - {"detail":"Not Found"}
... GET https://ete-litellm.ai-models.vpc-int.res.ibm.com/v1beta/models/gcp/gemini-3.5-flash-lite:cachedContents
```
Root cause: our model handle `gcp/gemini-3.5-flash-lite` starts with
`gemini-` after the provider prefix, and the gateway's default "native pin"
mode (`containers/gateways/litellm/start`) routes any client-requested model
matching `gemini-*` through litellm's **native** Vertex/Google-AI-Studio
Gemini SDK path (including a `:cachedContents` context-cache preflight) —
appropriate for a *real* Gemini API, wrong for our upstream, which is itself
just an OpenAI-compatible LiteLLM proxy. The documented fix is
`EVAL_MODEL_API=openai` (wire override — forces plain OpenAI-style forwarding
regardless of the model name), but grepping the whole repo confirmed **no
production path** (compose, CLI, or this Helm chart) exposes that env var to
users — it's implemented in `start` and exercised only by the test suite.

**Workaround applied (chart untouched):** deleted the first Job, hand-added
one line to the rendered YAML's gateway container `env:` block, reapplied:
```yaml
- { name: EVAL_MODEL_API,              value: "openai" }
```
```bash
oc delete job swe-bench-swe-agent-task-sympy-sympy-24661 -n eval-containers-b
# (edit sympy-job.yaml: add the EVAL_MODEL_API line right after EVAL_MODEL)
oc apply -n eval-containers-b -f sympy-job.yaml
```

**Result of the fixed run:** gateway logs immediately showed `POST
/v1/chat/completions HTTP/1.1 200 OK` (vs. the earlier 404s) — confirmed the
fix. The agent then ran for the full internal budget:
```bash
oc logs <pod> -n eval-containers-b -c gateway --tail=20
# → 200 OK, climbing call count (checked periodically: 83, then 151, ...)
```
Job reached `Complete` at the ~30-minute mark, matching
`EVAL_TIMEOUT=1800` (the chart's swe-bench preset default) — separate from
the Job's 40-minute `activeDeadlineSeconds` hard kill. Runner container
produced **no stdout** at all (`oc logs -c runner` empty) even after
completion — not a bug, the entrypoint writes everything to files under
`/output`/`/logs` instead of stdout by design.

## Phase 6 — Monitor

Used the `Monitor` tool (polling `oc get pods`/`oc get job` every 5s, only
printing on state change) instead of manual `sleep`+`oc get` loops — cleaner
for a ~30 minute wait. Mid-run, checked liveness directly since "Running"
alone doesn't prove progress:
```bash
oc logs <pod> -n eval-containers-b -c gateway | grep -c "POST /v1/chat/completions"
```
Watched this climb (83 → 151 → ...) across checks — confirmed the agent was
actually working, not stuck.

## Phase 7 — Fetch results to laptop

First inspected the PVC directly via the reader pod before trusting
`fetch.sh`'s assumptions:
```bash
oc apply -f deploy/eval-reader-pod.yaml -n eval-containers-b
oc wait --for=condition=ready pod/eval-reader -n eval-containers-b --timeout=60s
oc exec eval-reader -n eval-containers-b -- find /data/runs/swe-bench/swe-agent/gcp/gemini-3.5-flash-lite/sympy__sympy-24661
```
Confirmed files present: `agent/{stdout.log,stderr.log,.exit-code,patch.diff,result.json,.started-at}`,
`task/result.json`, `model/result.json`, `traces.jsonl`.

**Real result, confirmed:**
```json
task/result.json:  {"task_id":"sympy__sympy-24661","benchmark":"swe-bench","reward":0,"passed":false}
agent/result.json: {"agent":"swe-agent","started_at":"...","ended_at":"...","exit_code":124}
```
`exit_code: 124` = standard timeout exit code. `agent/stdout.log` tail
confirmed the agent was mid-investigation (step 186, 185 API calls, running
`python -c "from sympy import ..."` inside `/testbed`) when the internal
30-minute timeout killed it — genuine "didn't finish in time" outcome for
this small/fast model on this task, not an infrastructure failure.
`patch.diff` was 0 lines (never got to submitting a fix).

```bash
./deploy/oc/fetch.sh --benchmark swe-bench --agent swe-agent \
  --model gcp/gemini-3.5-flash-lite --namespace eval-containers-b
```
Confirmed: worked unmodified (its `_lib.sh` default namespace override via
`--namespace` was sufficient — no edits needed), files landed at
`output/swe-bench/swe-agent/gcp/gemini-3.5-flash-lite/sympy__sympy-24661/`.

**Gotcha (logged as A7 in `CHANGE-OPENSHIFT.md`):**
```bash
eval-containers report output/
# → error: no results found in output/
```
`report`'s recursion depth is hardcoded to 3, but `fetch.sh`'s own layout is
4+ levels deep (5 for a slash-containing model name like ours). Confirmed by
pointing it one level closer instead:
```bash
eval-containers report output/swe-bench/swe-agent/gcp/
```
```
BENCHMARK      TASK                 AGENT      MODEL                 REWARD  PASS  TOKENS  COST    TRACES
swe-bench      sympy__sympy-24661   swe-agent  gemini-3.5-flash-lite 0.00    FAIL  0       $0.000  OK
```
`TRACES OK` confirms OTel/gen_ai tracing worked end-to-end too. `TOKENS 0` /
`COST $0.000` is a separate, minor, not-pursued issue: litellm has no cost
entry for this custom model (`This model isn't mapped yet ... setting cost
to 0`), a litellm data-coverage limitation, not an eval-containers bug.

## Phase 8 — Repeat for astropy (`astropy__astropy-12907`)

Reused the already-built `agents/swe-agent`, `models/litellm`, `core/otel`
images — only needed a new per-task bench image + eval combo, same recipe as
Phase 4:
```bash
eval-containers --registry icr.io/tir-advisor-eval-containers \
  build bench swe-bench --task-id astropy__astropy-12907
docker image inspect .../benchmarks/swe-bench-astropy__astropy-12907:latest --format '{{.Architecture}}'   # amd64
docker push .../benchmarks/swe-bench-astropy__astropy-12907:latest

# eval combo — same buildx bake invocation as Phase 4, task-id/tags swapped
docker image inspect .../evals/swe-bench-astropy__astropy-12907--swe-agent:latest --format '{{.Architecture}}'  # amd64
docker push .../evals/swe-bench-astropy__astropy-12907--swe-agent:latest
```

Render + both known fixes (name sanitization, `EVAL_MODEL_API`) applied
together this time, no rediscovery needed:
```bash
helm template swe-agent-astropy containers/benchmarks/_chart \
  --set benchmark=swe-bench --set agent=swe-agent \
  --set task=astropy__astropy-12907 --set perTask=true \
  --set model=gcp/gemini-3.5-flash-lite --set gatewayImage=litellm \
  -f deploy/values-openshift.yaml \
  --set registry=icr.io/tir-advisor-eval-containers \
  --set outputVolume.persistentVolumeClaim.claimName=eval-output-pvc \
  --set outputSubPath=runs/swe-bench/swe-agent/gcp/gemini-3.5-flash-lite/astropy__astropy-12907 \
  > astropy-job.yaml
sed -i '' \
  -e 's/name: swe-bench-swe-agent-task-astropy__astropy-12907/name: swe-bench-swe-agent-task-astropy-astropy-12907/' \
  -e '/EVAL_MODEL,.*gcp\/gemini/a\
            - { name: EVAL_MODEL_API,              value: "openai" }' \
  astropy-job.yaml
oc apply -n eval-containers-b -f astropy-job.yaml
```
Confirmed gateway `200 OK` from the start (no repeat of gotcha #5 — the fix
was baked into the render this time). Job ran the full ~30 minutes and
completed:
```json
task/result.json:  {"task_id":"astropy__astropy-12907","benchmark":"swe-bench","reward":0,"passed":false}
agent/result.json: {"agent":"swe-agent", ..., "exit_code":124}
```
Same outcome as sympy — internal timeout, not an infra failure. Fetched +
reported both tasks together:
```bash
./deploy/oc/fetch.sh --benchmark swe-bench --agent swe-agent --model gcp/gemini-3.5-flash-lite --namespace eval-containers-b
eval-containers report output/swe-bench/swe-agent/gcp/
```
```
BENCHMARK   TASK                    AGENT      MODEL                  REWARD  PASS  TRACES
swe-bench   astropy__astropy-12907  swe-agent  gemini-3.5-flash-lite  0.00    FAIL  OK
swe-bench   sympy__sympy-24661      swe-agent  gemini-3.5-flash-lite  0.00    FAIL  OK
TOTAL       2 tasks                                                   0.00    0/2   all OK
```
**Flake noted, not a bug worth filing:** this `fetch.sh` run printed
`Dropping out copy after 0 retries` / `(nothing at ... yet)` for the astropy
`oc cp`, suggesting the copy failed — but a direct `find` on the local
`output/` tree confirmed all the astropy files were actually there intact
(and `report` read them correctly). Transient `oc cp` flakiness, not data
loss; not reproduced on the first (sympy) fetch.

**Pipeline proven twice, end to end, on two different SWE-bench Verified
instances (sympy, astropy), both real timeout outcomes rather than
infrastructure failures.**

## Phase 9 — AppWorld + `terminus-2` (shared-env / Indexed Job path)

10-minute recon before touching anything (per `containers/benchmarks/appworld/README.md`
and the chart's `containers/benchmarks/_chart/presets/`, `task-profiles/`
dirs), confirmed up front rather than discovered mid-debug:

- **Environment: shared-env** (732 tasks, one bench image) — this is the
  **other** untested chart path flagged in the Generalization notes below:
  Indexed Jobs / `datasetSize`, not per-task single-task Jobs.
- **Internet required: false** — no extra egress concerns.
- **No site sidecars needed** — no `task-profiles/appworld.json`, no
  `sidecars:` catalog entry; AppWorld's `bridge.py` is a self-contained
  in-container HTTP service, not an external service dependency. (The
  sidecar mechanism itself — used by `webarena`/`enterpriseops-gym` — is
  still untested; AppWorld just doesn't need it.)
- **No `presets/appworld.yaml` exists** — the chart only ships 6 presets
  (`swe-bench`, `tau-bench`, `webarena`, `visualwebarena`,
  `enterpriseops-gym`, `osworld`); AppWorld is driven entirely by `--set`
  overrides, same as the docs' `aime` shared-env example.
- **`terminus-2`** (`containers/agents/terminus-2/`): standard
  runner-execs-an-in-container-orchestrator shape, same wiring pattern as
  `swe-agent` — no unusual chart/env requirements.

**Environment/cluster state reused, not recreated** — confirmed the
namespace, PVC (`Bound`, RWX), `anyuid-sa` (with `icr-pull-secret` still
linked), `eval-secrets`, and local ICR docker auth were all still valid from
the SWE-bench session 3+ days later; zero B1–B4 setup steps repeated.

**Build (dry-run first, confirmed both are plain `bake` targets — no
per-task `--builder oc` special-casing like SWE-bench's bench image):**
```bash
eval-containers --registry icr.io/tir-advisor-eval-containers build bench appworld --dry-run
eval-containers --registry icr.io/tir-advisor-eval-containers build agent terminus-2 --dry-run
```
Confirmed: both resolve to `benchmark-appworld` / `agent-terminus-2` bake
targets.

**Gotcha (session-local mistake, not a repo bug — logged here per the
runbook's "dead ends and corrections" convention, not in `CHANGE-OPENSHIFT.md`
since it's not a deviation from committed tooling):** hand-invoked
`docker buildx bake` directly (to force `--set '*.platform=linux/amd64'`,
per A2) without also exporting `REGISTRY=icr.io/tir-advisor-eval-containers`
— the CLI wrapper normally sets this automatically, but a direct `bake`
call doesn't infer it. Both images built correctly (confirmed `amd64` via
`docker image inspect`) but landed at the bake file's own default name
(`ghcr.io/exgentic/benchmarks/appworld:latest`,
`ghcr.io/exgentic/agents/terminus-2:latest`) instead of the ICR path. Fixed
with `docker tag` + `docker push` rather than rebuilding:
```bash
docker tag ghcr.io/exgentic/benchmarks/appworld:latest icr.io/tir-advisor-eval-containers/benchmarks/appworld:latest
docker tag ghcr.io/exgentic/agents/terminus-2:latest icr.io/tir-advisor-eval-containers/agents/terminus-2:latest
docker push icr.io/tir-advisor-eval-containers/benchmarks/appworld:latest
docker push icr.io/tir-advisor-eval-containers/agents/terminus-2:latest
```

**Eval combo build** — passed `GOSU_IMAGE`'s public-default override (A3)
proactively this time, since the root cause (fresh registry, no `core/gosu`
pushed) is unchanged:
```bash
docker buildx bake -f ... --load --set '*.platform=linux/amd64' \
  --set eval.args.BENCHMARK_IMAGE=icr.io/tir-advisor-eval-containers/benchmarks/appworld:latest \
  --set eval.args.AGENT_IMAGE=icr.io/tir-advisor-eval-containers/agents/terminus-2:latest \
  --set eval.args.GOSU_IMAGE=ghcr.io/exgentic/core/gosu:latest \
  --set eval.tags=icr.io/tir-advisor-eval-containers/evals/appworld--terminus-2:latest \
  eval
docker push icr.io/tir-advisor-eval-containers/evals/appworld--terminus-2:latest
```
Confirmed `amd64`, no `GOSU_IMAGE` 404 (avoided, not just worked around after
the fact).

**Render (datasetSize=1, no preset file, `perTask` left at chart default):**
```bash
helm template appworld-terminus2 containers/benchmarks/_chart \
  --set benchmark=appworld --set agent=terminus-2 \
  --set datasetSize=1 \
  --set model=gcp/gemini-3.5-flash-lite --set gatewayImage=litellm \
  -f deploy/values-openshift.yaml \
  --set registry=icr.io/tir-advisor-eval-containers \
  --set outputVolume.persistentVolumeClaim.claimName=eval-output-pvc \
  --set outputSubPath=runs/appworld/terminus-2/gcp/gemini-3.5-flash-lite
```
Confirmed clean render: `completionMode: Indexed`, `completions: 1`,
`parallelism: 1`, runner `args` correctly exports
`EVAL_TASK_ID="$JOB_COMPLETION_INDEX"`, **no `wait-sidecars` init container**
(confirms the sidecar mechanism correctly stays inert for a benchmark with
no catalog entry), Job name `appworld-terminus-2` (task id never appears in
`metadata.name` for dataset-mode Jobs — A5 doesn't apply here). Hand-added
the one known-necessary line (A6) before applying:
```yaml
- { name: EVAL_MODEL_API,              value: "openai" }
```
Chart's *default* timeout (`EVAL_TIMEOUT=300`, `activeDeadlineSeconds=900`)
was left untouched deliberately — no AppWorld preset exists to override it,
and nothing yet suggested it was insufficient.

**Apply + monitor:**
```bash
oc apply -n eval-containers-b -f appworld-job.yaml
# → job.batch/appworld-terminus-2 created
```
Watched via the `Monitor` tool (age-stripped this time — an early attempt
that included the pod AGE column in the diff fired a notification on every
5s tick since the age string itself always changes; stripped to just
`NAME READY STATUS RESTARTS` + job succeeded/failed/active counts, which
only changes on a real state transition). Progression: `Init:1/2` (otelcol)
→ `PodInitializing` (gateway) → `3/3 Running` (runner) → `Completed`.
Gateway logged `200 OK` from its very first request — the A6 fix applied
cleanly with no rediscovery.

**Result, confirmed real (not infra failure):**
```json
task/result.json:  {"task_id":"0","benchmark":"appworld","reward":1.0,"passed":true}
agent/result.json: {"agent":"terminus-2","started_at":"2026-08-17T08:07:43Z","ended_at":"2026-08-17T08:11:02Z","exit_code":0}
```
Job `startTime` 08:06:39 → `completionTime` 08:11:08 (~4m29s wall clock,
including image pulls + otelcol/gateway startup) — well under the chart's
default 900s `activeDeadlineSeconds`; no timeout tuning was needed for a
single AppWorld task. `agent/stdout.log` showed 40 episodes / 40 model calls
with per-call latencies; `agent/stderr.log` had one benign
`Failed to install asciinema using pip` line (harmless — Terminus-2's
optional session-recording dependency, exit code still 0, reward still
1.0 — not investigated further since it didn't affect the outcome).

**Fetch + report** — same known A7 depth-cap gotcha recurred identically
(expected, not new):
```bash
./deploy/oc/fetch.sh --benchmark appworld --agent terminus-2 --model gcp/gemini-3.5-flash-lite --namespace eval-containers-b
eval-containers report output/                    # → error: no results found in output/ (A7, as expected)
eval-containers report output/appworld/terminus-2/gcp/
```
```
BENCHMARK            TASK                           AGENT           MODEL                          REWARD   PASS   TRACES
appworld             0                              terminus-2      gemini-3.5-flash-lite          1.00     PASS   OK
TOTAL                1 tasks                                                                       1.00     1/1    all OK
```
`TRACES OK` confirms OTel tracing works on the Indexed-Job path too, not
just single-task Jobs.

**First AppWorld+terminus-2 run on OpenShift, proven end to end, via the
previously-untested Indexed Job / `datasetSize` path — with a genuine pass,
not just a completed-but-inconclusive outcome.**

## Generalization notes (for scripting / step-by-step write-ups)

These are things a fresh session should know before generalizing the recipe
above beyond "SWE-bench, per-task, swe-agent, this one model/endpoint":

- **`EVAL_MODEL_API` rule, stated generally:** the specific failure in Phase
  5 (gotcha #5) generalizes to a rule, not just an incident. Whenever the
  upstream endpoint (`OPENAI_API_BASE`) is itself an OpenAI-wire-compatible
  proxy — which is the case for *any* LiteLLM-fronted custom endpoint,
  regardless of what model names it serves — set `EVAL_MODEL_API=openai`
  unconditionally. The gateway's "native pin" default (no `EVAL_MODEL_API`)
  is only safe when the model name's family prefix (`claude-*`/`gemini-*`)
  genuinely matches the wire protocol the upstream speaks (e.g. calling
  Anthropic directly for a `claude-*` name, or real Google AI Studio/Vertex
  for a `gemini-*` name) — not when a custom proxy happens to name a model
  `gemini-...` while only speaking OpenAI's wire. A script should not try to
  infer this from the model string; it should be a property of the *upstream
  endpoint type*, supplied alongside `OPENAI_API_BASE`.
  **Confirmed a second time in Phase 9** (AppWorld/`terminus-2`, same
  endpoint) — strengthens the case this is endpoint-scoped, not
  benchmark/agent-scoped.
- **Both benchmark-shape paths are now exercised.** SWE-bench (Phases 0–8)
  is `env=per-task` (one image per task instance, single-task Job, no
  `datasetSize`). **Phase 9 (AppWorld) exercised the other shape** — a
  shared-env benchmark run as a dataset/Indexed Job (`--set datasetSize=1`)
  — end to end, with a genuine pass. Still open/unverified from that proof:
  only `datasetSize=1` (not a real multi-task sweep with `parallelism>1`),
  only one shared-env benchmark (AppWorld), and the **site-sidecar
  mechanism** (`sidecars:`/`task-profiles/*.json`, used by
  `webarena`/`enterpriseops-gym`) remains completely untested — AppWorld
  happened not to need it. A script "parameterized by benchmark" should
  still branch on the benchmark's `README.md` `Environment` field, but the
  branch itself (`datasetSize=<N>` vs. single-task `task=<id>`) is now
  proven correct in both directions, not just asserted from reading the
  chart.
- **Idempotency wasn't a design goal of this narrative.** The namespace/SA/
  SCC-binding/PVC/secrets/pull-secret setup in Phases 1–2 and Phase 4 ran
  once, linearly, against a clean namespace. A script meant to be re-run
  safely needs check-then-create logic (`oc get X || oc apply/create X`) for
  each of those, which isn't spelled out step-by-step above — it's implied
  by "apply is generally idempotent for unchanged manifests" but the
  Secret/pull-secret/API-key creation steps are not idempotent as written
  (re-running `oc create secret` on an existing name fails; would need
  `oc apply` with a full manifest, or a delete-then-create, or an existence
  check first).
- **Only one model and one region/account were tested throughout.** `gcp/
  gemini-3.5-flash-lite` via IBM's `ete-litellm` endpoint, in every run
  (Phases 0–9). **Two agents are now proven** — `swe-agent` (Phases 0–8) and
  `terminus-2` (Phase 9) — both worked against this gateway setup with the
  same `EVAL_MODEL_API=openai` override and no agent-specific chart changes,
  which is mild evidence the gateway wiring is agent-agnostic, but two data
  points isn't proof for every agent's entrypoint (different
  `--agent.model.*`-style CLI flags, different env var expectations could
  still surprise us).
