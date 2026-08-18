# OpenShift deployment — changes and deviations

This tracks every deviation from the repo's committed OpenShift tooling
discovered while running SWE-bench Verified (`swe-agent` harness) on a shared
OpenShift cluster, split into two categories:

- **A. Upstream-worthy** — a general bug, gap, or missing parameterization in
  the existing `eval-containers` OpenShift tooling that would help *any*
  deployment, not just ours. Candidates for a PR back to the project.
- **B. Local-only** — specific to this cluster/environment/account. Not
  useful upstream; would only confuse other deployments.

See the bottom of this file for the selective-PR strategy for category A.

Entries are added as each change is actually made and confirmed working (see
`README-Openshift-tested.md` for the exact commands/output each entry
corresponds to), not batched at the end.

**Outcome:** the full pipeline (build → push → cluster pull → gateway →
agent → grading → PVC → fetch → report) was proven twice, end to end, on two
real SWE-bench Verified instances (`sympy__sympy-24661`,
`astropy__astropy-12907`) with `swe-agent` against
`gcp/gemini-3.5-flash-lite`. Both runs completed with a real `reward: 0` /
`exit_code: 124` (internal 30-minute timeout, agent still working) — a
genuine model/timeout outcome, not an infrastructure failure. Getting there
required six confirmed upstream-worthy findings (A1–A7 below) and four
local-only adaptations (B1–B4).

**Second benchmark proven (AppWorld + `terminus-2`, shared-env / Indexed
Job path):** the same infra (namespace, PVC, secrets, pull secret — none
re-created) was reused to run AppWorld's task `0` via `terminus-2` against
the same model/endpoint, this time through the chart's **`datasetSize`
Indexed-Job mechanism** — the other, previously-untested per-task-vs-shared-env
branch flagged in the Generalization notes below. Result: a real
`reward: 1.0` / `passed: true` / `exit_code: 0` in ~4m29s wall-clock
(well under the chart's *default* 300s/900s timeout — no override needed).
See `README-Openshift-tested-exploration.md` Phase 9 for the full narrative.
This run needed **zero new category-A or category-B findings** — A2, A6, A7
recurred identically (see their sections below, now marked "confirmed
twice"), and A3/A4/A5 were confirmed *not applicable* to this benchmark
shape for structural reasons, not luck. That's meaningful signal: the six
findings from the SWE-bench run generalize across a structurally different
benchmark (shared-env vs. per-task, dataset-mode Job vs. single-task Job,
a different agent) rather than being SWE-bench-specific quirks.

## Summary (quick scan)

| # | What | Category | Status |
|---|------|----------|--------|
| B1 | Namespace `eval-containers-b`, not `exgentic-ns` | Local-only | Applied |
| B2 | PVC storage class `ibm-spectrum-scale-fileset`, not `ibmc-vpc-file-retain-1000-iops` | Local-only | Applied |
| B3 | External registry (ICR), not OpenShift internal registry (disabled cluster-wide) | Local-only | Applied |
| B4 | `flatImages` unset (default), not `true` — ICR supports nested paths | Local-only | Applied |
| A1 | PVC hardcodes namespace + one cloud's storage class | Upstream candidate | Optional/skippable — see opinion below |
| A2 | No way to target a non-host build platform (`--platform`) | Upstream candidate | Issue first, PR after maintainer signal — confirmed 2× |
| A3 | `GOSU_IMAGE` default breaks builds against a fresh registry | Upstream candidate | Worth an issue + PR — confirmed 2× |
| A4 | No per-task benchmark preset sets `perTask: true` | Upstream candidate | Worth an issue + PR (priority) — confirmed out of scope for shared-env |
| A5 | Job name not sanitized for `_` in task IDs | Upstream candidate | Worth an issue + PR (priority) — confirmed out of scope for dataset-mode Jobs |
| A6 | `EVAL_MODEL_API` documented but wired nowhere for users | Upstream candidate | Issue first, PR scoped to chart only — confirmed 2× |
| A7 | `report`'s recursion depth shallower than `fetch.sh`'s own layout | Upstream candidate | Worth an issue + PR (priority) — confirmed 2× |

See "Is it actually worth turning these into PRs?" below the strategy
section for the reasoning behind each status — worth noting up front that
**every one of these was worked around with zero repo file changes**, which
is itself part of that reasoning.

## B. Local-only

### B1. Namespace: `eval-containers-b`, not the scripts' `exgentic-ns` default

`deploy/oc/_lib.sh`'s `NS_DEFAULT` and the committed
`deploy/eval-output-pvc.yaml` both hardcode `exgentic-ns`. Live inspection
showed that namespace already exists on this cluster and already hosts an
unrelated service account (`inference-perf-runner`) — it belongs to another
project, not to this work. We use `eval-containers-b` (created fresh)
instead, and pass `--namespace eval-containers-b` to every `deploy/oc/*.sh`
invocation, or apply namespaced manifests with an explicit `-n
eval-containers-b` / edited `metadata.namespace`.

**Why:** the namespace name is inherently deployment-specific — every team
running this repo on a shared cluster needs their own namespace, so
`exgentic-ns` was never going to be reusable across deployments as-is. Not a
bug, just a value that has to be supplied per-deployment (see A1 below for
the one place this *is* worth improving upstream).

### B2. PVC storage class: `ibm-spectrum-scale-fileset`, not `ibmc-vpc-file-retain-1000-iops`

`deploy/eval-output-pvc.yaml` hardcodes `storageClassName:
ibmc-vpc-file-retain-1000-iops`, an IBM-Cloud-VPC-specific class. This
cluster (`pokprod001.ete14.res.ibm.com`, an internal IBM Research OpenShift
cluster, not IBM Cloud VPC) doesn't have that class. `oc get storageclass`
showed `ibm-spectrum-scale-fileset` (cluster default, RWX-capable) instead.
Applied a patched PVC manifest (namespace + storage class swapped) via
stdin — confirmed `Bound`, RWX, on the first try. The committed repo file was
not edited (kept as the upstream author's reference default); our substitute
values are recorded here and in the runbook instead.

**Why:** storage classes are cluster-specific by nature (IBM Cloud VPC vs.
IBM Research on-prem vs. any other provider all name theirs differently).

### B3. Registry: IBM Cloud Container Registry (`icr.io/tir-advisor-eval-containers`), not the OpenShift internal registry

**What:** all `--registry` / chart `registry=` values point at
`icr.io/tir-advisor-eval-containers` (external, IBM Cloud) rather than
`image-registry.openshift-image-registry.svc:5000/eval-containers-b` (the
cluster's internal registry).

**Why:** confirmed live that this cluster's internal image registry is
administratively disabled — `oc get configs.imageregistry.operator
cluster -o jsonpath='{.spec.managementState}'` → `Removed`, condition
message "The registry is removed." No `image-registry` service, no route, no
`ImageStreamTag` backing at all. This isn't a capacity problem to work around
— it rules out both `docker push` to the internal registry and
`--builder oc` (whose `BuildConfig` output target is an `ImageStreamTag`,
which needs that same registry). An external registry is the only option on
this particular cluster.

**Follow-on setup, also local-only:**
- Docker auth: `ibmcloud cr login --client docker` (short-lived token; must
  be refreshed if it expires between sessions — hit this once, refreshed and
  it worked).
- Cluster pull auth: a dedicated IBM Cloud IAM API key
  (`ibmcloud iam api-key-create eval-containers-b-pull`), wrapped in an
  OpenShift `docker-registry` Secret (`icr-pull-secret`, namespace
  `eval-containers-b`), linked to the `anyuid-sa` service account via
  `oc secrets link anyuid-sa icr-pull-secret --for=pull`. Confirmed via a
  live pull test (`oc describe pod` → `Successfully pulled image`) — this is
  the mechanism, not the internal registry's implicit access, so it has to
  be set up per-namespace on this cluster.

### B4. `flatImages=true` dropped — only needed for OpenShift's internal registry

Phase 3's dry-run render used `--set flatImages=true` because the docs'
OpenShift examples all use it (it exists to work around the internal
registry's ImageStream naming restriction — no slashes allowed). Once we
switched to an external registry (B3, ICR), this restriction doesn't apply:
ICR supports arbitrary nested repository paths, same as the CLI's own default
naming (`benchmarks/<name>`, `agents/<name>`, `evals/<b>-<task>--<a>`, etc.).
**We now render with `flatImages` unset (default `false`)** and reference
images at their normal nested paths — this also means the images we already
built and pushed under the CLI's own naming (see B3/A2 below) are usable
as-is, with no renaming step.

**Why:** avoids a whole class of double-dash/flattening mismatches between
what `eval-containers build` produces and what the chart's `flatImages`
helper expects (see A2) — moot once nested paths are usable at all.

## A. Upstream-worthy (candidates — none applied yet without confirming they're needed)

### A1 (candidate, not yet confirmed necessary). `deploy/eval-output-pvc.yaml` and `deploy/oc/_lib.sh`'s `NS_DEFAULT` hardcode a specific namespace/storage-class pair

Both values are inherently deployment-specific (see B1/B2), yet they're
baked into a committed manifest and a shared script default rather than
parameterized. A user following `docs/guides/deploy-on-openshift.md` on any
cluster other than the original author's will hit exactly what we hit:
either edit the file, or pass `-n <ns>` everywhere and separately patch the
PVC's `storageClassName`. A more upstream-friendly version could:
- Drop `metadata.namespace` from `deploy/eval-output-pvc.yaml` entirely
  (namespaced resources don't need to declare it; `oc apply -n <ns>` already
  scopes it) — this alone would have saved our B1 PVC edit.
- Make `storageClassName` a documented placeholder/most-common default with
  a comment pointing at `oc get storageclass`, rather than one specific
  provider's class name, since it's unlikely to exist verbatim on any other
  cluster.

**Status:** flagged, not yet drafted as a PR.

### A2 (candidate). Building on Apple Silicon for an x86_64 cluster silently produces the wrong architecture

None of `eval-containers build agent|model` (bake-based) accept a
`--platform` flag, and `DOCKER_DEFAULT_PLATFORM=linux/amd64` is **silently
ignored** by `docker buildx bake` (confirmed live: same env var, same
command, still built `arm64` on this arm64 Mac). The only way found to force
the right architecture was bypassing the CLI and hand-invoking `docker buildx
bake ... --set '*.platform=linux/amd64'` directly. This is a real
correctness trap: an Apple Silicon user building for an x86_64 cluster gets
no warning or error — just a wrong-arch image that fails at pod-run time with
`exec format error` (confirmed with a throwaway `busybox` test in B3). The
one benchmark that *did* build correct-arch by accident
(`build bench --task-id`, plain `docker build`) only did so because its
Dockerfile hard-pins an x86_64-only upstream base image, forcing BuildKit to
emulate regardless of host platform — that's incidental, not something the
CLI arranged.

**Suggested upstream fix:** add a `--platform` flag to `eval-containers
build` (agent/bench/model/eval), threaded through as `--set
'*.platform=<value>'` to the underlying `bake` invocation; at minimum,
document the `--set` workaround in `docs/guides/install.md` or a
cross-compilation guide, since `docs/guides/podman-on-apple-silicon.md`
covers *running* on Apple Silicon but not *building for a different target*
from it.

**Status:** flagged, not yet drafted as a PR. **Confirmed a second time**
building `benchmark-appworld`/`agent-terminus-2` (plain `bake`, no `--builder
oc` involved) — same silent-arm64 outcome, same `--set '*.platform=linux/amd64'`
fix, no new wrinkle.

### A3 (candidate). `eval` bake target's `GOSU_IMAGE` default silently requires the *target* registry to already host `core/gosu`

Building the per-task `eval` combo image against a **fresh** registry (one
we've only just started publishing to, with none of the `core-*` base images
pushed yet) fails: `variable "GOSU_IMAGE" { default =
"${REGISTRY}/core/gosu:${TAG}" }` in
`containers/core/combination.docker-bake.hcl` overrides the Dockerfile's own
more resilient default (`ARG GOSU_IMAGE=ghcr.io/exgentic/core/gosu:latest`,
a small public upstream-style utility image with no reason to live in every
downstream registry). The failure mode is a registry 404
(`icr.io/.../core/gosu:latest: not found`) with no hint that overriding
`REGISTRY` for a first-time deployment implicitly requires either (a)
bootstrapping every `core-*` image into the new registry first, or (b)
knowing to override `GOSU_IMAGE` back to the public default by hand — we
only found (b) by reading the bake HCL source. `deploy/examples/openshift/`
covers this for the `--builder oc` in-cluster path (its "Bootstrapping core
bases" section), but there's no equivalent guidance for a first-time
external-registry deployment building locally with plain `bake`.

**Suggested upstream fix:** either point `GOSU_IMAGE`'s bake-level default at
the Dockerfile's own public fallback instead of unconditionally deriving it
from `REGISTRY`, or call this out explicitly in
`docs/guides/deploy-on-openshift.md` / `docs/guides/install.md` for anyone
pointing `--registry` at a brand-new registry.

**Status:** flagged, not yet drafted as a PR. Worked around by explicitly
passing `--set eval.args.GOSU_IMAGE=ghcr.io/exgentic/core/gosu:latest`.
**Avoided proactively for the AppWorld `eval` combo build** (same registry,
still no `core/gosu` pushed to it) by passing the override from the start
instead of rediscovering the failure — same root cause, no new information,
just confirms the workaround generalizes to any benchmark/agent combo built
against this registry.

### A4 (candidate, higher confidence — systemic). No per-task benchmark's chart preset sets `perTask: true`

`containers/benchmarks/_chart/templates/_helpers.tpl`'s `eval.runnerImage`
picks the image-name shape based on `.perTask` (per-task naming:
`evals/<bench>-<task>--<agent>`, vs. shared-env naming:
`evals/<bench>--<agent>`), and `job.yaml` uses the same flag to reject an
invalid per-task + `datasetSize` combination. **`.perTask` defaults `false`
and no per-task benchmark's `presets/<name>.yaml` sets it to `true`** —
confirmed by checking every benchmark whose `README.md` declares `|
Environment | per-task |` against its preset file:

| benchmark | preset has `perTask: true`? |
|---|---|
| compilebench | no preset file at all |
| cybench | no preset file at all |
| mle-bench | no preset file at all |
| skills-bench | no preset file at all |
| swe-bench-pro | no preset file at all |
| swe-bench | preset exists, sets only `timeout` |
| swe-lancer | no preset file at all |
| terminal-bench | no preset file at all |

Practical effect, confirmed live: `helm template --set benchmark=swe-bench
--set agent=swe-agent --set task=<id> ...` (exactly the command the plain-Helm
example in `docs/guides/deploy-on-openshift.md` shows) renders a runner
`image:` pointing at `evals/swe-bench--swe-agent:latest` (the shared-env
name) instead of `evals/swe-bench-<task>--swe-agent:latest` (what
`eval-containers build eval --task-id <id>` actually produces and pushes).
No error, no warning — just a pod that will `ImagePullBackOff` on a name that
was never built, or worse, silently pull a *different* task's leftover image
if one happens to exist at the shared-env name. The `job.yaml` per-task +
`datasetSize` safety check is also silently bypassed, since it also gates on
this same flag.

**Suggested upstream fix:** every per-task benchmark's `presets/<name>.yaml`
should include `perTask: true` (add the seven missing preset files, add the
one line to `swe-bench.yaml`), so the plain-Helm example in the OpenShift/
Kubernetes deploy guides works correctly without the user needing to know
this internal flag exists.

**Status:** flagged, not yet drafted as a PR. Worked around for our render by
passing `--set perTask=true` explicitly. **Confirmed out of scope for
shared-env benchmarks:** rendering AppWorld (shared-env, `datasetSize=1`)
with `perTask` left at its default (`false`) produced the correct runner
image name (`evals/appworld--terminus-2:latest`, the shared-env shape) —
no `--set perTask=true` needed, because the default is *correct* for
shared-env benchmarks and only wrong for per-task ones. This bug is
specifically about per-task benchmarks' presets not setting the flag their
own shape requires; it doesn't generalize to shared-env at all.

### A5 (candidate, confirmed via a real `oc apply` failure). Job name isn't sanitized for task IDs containing underscores

`templates/job.yaml`'s single-task Job name is
`{{ $v.benchmark }}-{{ $v.agent }}-task-{{ $v.task }}{{ $v.nameSuffix }}`,
with `.task` embedded verbatim. SWE-bench (and the SWE-bench family
generally) uses instance IDs with a double underscore, e.g.
`sympy__sympy-24661`. Kubernetes object names must be RFC 1123 subdomains
(lowercase alphanumeric, `-`, `.` only — no `_`), so `oc apply` rejects the
rendered Job outright:
```
metadata.name: Invalid value: "swe-bench-swe-agent-task-sympy__sympy-24661":
a lowercase RFC 1123 subdomain must consist of ...
```
This is **not** caught by `helm template` (no API-server validation at
render time) — only surfaces at `oc apply`/`kubectl apply`, so anyone
following the docs' plain-Helm example for SWE-bench hits this immediately.
Note labels are fine (`task: "sympy__sympy-24661"` — label *values* permit
underscores; only object *names* don't), so this is purely the `metadata.name`
line.

**Suggested upstream fix:** sanitize `.task` the same way `eval.flat` already
sanitizes image names for the internal registry — e.g. `{{ $v.task | replace
"_" "-" }}` in the Job name construction — so any task ID with underscores
(not just SWE-bench's) round-trips safely.

**Status:** flagged, not yet drafted as a PR. Worked around by patching just
the rendered `metadata.name` line before `oc apply` (see runbook) — the
chart file itself was not edited. **Confirmed out of scope for dataset-mode
Jobs:** `job.yaml`'s dataset-mode Job name (`datasetSize` set) is
`<benchmark>-<agent>` — the task id/completion index is never embedded in
`metadata.name` at all (see line 16), only in labels and
`JOB_COMPLETION_INDEX`. AppWorld's `datasetSize=1` render's Job name
(`appworld-terminus-2`) applied with no sanitization needed. This bug is
purely a single-task-Job naming issue; the dataset-mode path was never
exposed to it structurally.

### A6 (candidate, high confidence, framework-wide — not OpenShift-specific). `EVAL_MODEL_API` is documented but wired nowhere a real user can set it

`.agents/gateways/RULES.md` rule 2 defines `EVAL_MODEL_API` as an OPTIONAL,
user-facing env var (wire-protocol override: `anthropic|openai|gemini`), and
`containers/gateways/litellm/start` fully implements reading it (three modes:
wire-override / native-pin / passthrough — see rule 2b). But grepping the
**entire** repo for `EVAL_MODEL_API` only turns up: the doctrine
(`.agents/gateways/RULES.md`), the gateway's own `start` script, and the test
harness (`tests/run/gateways/translation.rs`, which sets it by injecting the
container env var directly). **No production path threads a user-supplied
value through at all** — not `containers/compose/services.yaml`, not the CLI
(`cli/src/*.rs`), not the Kubernetes/OpenShift Helm chart
(`containers/benchmarks/_chart/values.yaml` has no `modelApi`/similar key,
and `templates/job.yaml`'s gateway `env:` block never references it). This
isn't a compose-vs-k8s parity gap — it's missing everywhere outside the test
suite.

**Why this matters in practice (confirmed live, not theoretical):** our
model handle is `gcp/gemini-3.5-flash-lite`. `start`'s NATIVE PIN default
(the only mode reachable without `EVAL_MODEL_API`) builds three model-name
family routes (`claude-*`, `gemini-*`, `*`), and litellm's proxy picks a
route by matching the *client's requested model string* — which here starts
with `gemini-`, so it's routed via litellm's **native** Gemini/Vertex AI SDK
provider (`gemini/${EVAL_MODEL}`, hitting `.../v1beta/models/...`, including
a context-caching preflight call to `:cachedContents`). Our actual upstream
(`https://ete-litellm.ai-models.vpc-int.res.ibm.com`) is itself just an
OpenAI-compatible LiteLLM proxy — it doesn't implement that Gemini-native
surface, so the preflight call 404s and every completion request fails. This
is a real, load-bearing bug for our run, not a style nit: **any model handle
whose name happens to start with `claude-` or `gemini-`, pointed at a plain
OpenAI-compatible endpoint, breaks under the chart's native-pin default** —
and there is currently no supported way to set `EVAL_MODEL_API=openai` to
route around it, short of hand-editing the rendered manifest (see workaround
below) or the compose file.

**Suggested upstream fix:** add `EVAL_MODEL_API` (as e.g. chart value
`modelApi`, CLI flag `--model-api`, and a compose `.env` var) all wired
through to the gateway container's env, mirroring how `EVAL_MODEL` is
already threaded everywhere. This closes a real functional gap, not just an
OpenShift one — worth raising as its own, carefully-scoped PR.

**Status:** flagged, not yet drafted as a PR. Workaround for our render:
hand-add `EVAL_MODEL_API: "openai"` to the gateway container's `env:` block
in the rendered Job YAML before `oc apply` (see runbook) — chart untouched.
**Confirmed a second time, on a structurally different benchmark/agent
(AppWorld + `terminus-2`, shared-env/dataset-mode):** applied the same
`EVAL_MODEL_API=openai` line proactively (known-necessary for this endpoint
regardless of model/benchmark) and the gateway logged `200 OK` from its very
first request — no repeat of the `:cachedContents` 404. This strengthens the
generalization already stated above: the bug is a property of the
*upstream endpoint type*, not of any one benchmark, agent, or model.

### A7 (candidate, high confidence, confirmed by direct code read). `eval-containers report` can't find results at the depth its own `deploy/oc/fetch.sh` writes them

`cli/src/report.rs`'s `find_results` calls `walk_for_results(dir, &mut
results, 3)` — a **hardcoded max recursion depth of 3** — looking for
`task/result.json` at up to 3 directory levels below the path given.
`deploy/oc/fetch.sh` (the very script `deploy/oc/README.md`'s own Quickstart
tells you to run right before `eval-containers report output/`) writes
results to `output/<benchmark>/<agent>/<model>/<task-id>/task/result.json` —
**4 levels**, one more than the walker allows, so `report` silently returns
`error: no results found in output/` even though the files are right there.
It gets worse whenever the model string itself contains a `/` (any
provider-prefixed handle like our `gcp/gemini-3.5-flash-lite`) — that's a
5th level, since each path segment of the model string becomes its own
directory. Confirmed by pointing `report` directly at the deeper path
(`eval-containers report output/swe-bench/swe-agent/gcp/`), which produced a
correct table (`REWARD 0.00 FAIL ... TRACES OK`) — so the bug is purely the
depth cap, not the file contents or the fetch layout itself.

**Why this matters:** this isn't an edge case — it breaks the documented
`./oc/fetch.sh ... && eval-containers report output/` two-liner from the
Quickstart for the *default* single-model case, and definitely for any
provider-prefixed model name (which the framework's own doctrine
(`.agents/models/RULES.md`) explicitly expects, e.g. `aws/claude-opus-4-8`,
`gcp/gemini-3-flash-preview`).

**Suggested upstream fix:** either raise the depth cap (e.g. to 6+, generous
enough for `<benchmark>/<agent>/<model-with-slashes>/<task-id>/`), or replace
the fixed-depth walk with an unbounded recursive search that just always
looks for `task/result.json` — simpler and future-proof against any deploy
script choosing a different nesting.

**Status:** flagged, not yet drafted as a PR. Workaround: point `report` at
a deeper subdirectory manually (e.g. `output/<benchmark>/<agent>/`) instead
of the bare `output/` root. **Confirmed a second time, identically:**
AppWorld's fetch layout is the same depth (`output/appworld/terminus-2/gcp/gemini-3.5-flash-lite/0/task/result.json`,
5 levels below `output/` for this provider-prefixed model) — `report
output/` failed with the same `error: no results found`, `report
output/appworld/terminus-2/gcp/` succeeded with a correct `REWARD 1.00 PASS`
row. Confirms this is a general depth-cap bug, not swe-bench-specific.

**Secondary, minor, not pursued further:** `model/result.json` only ever
contained `{"model": "gemini-3.5-flash-lite"}` — no `total_tokens`/`cost_usd`
— because litellm's cost DB has no entry for this custom model
(`Error calculating cost: This model isn't mapped yet ... setting cost to
0`, seen in the agent log). This is a litellm data-coverage limitation for
unmapped custom models, not something specific to our OpenShift setup — not
logged as a numbered candidate above since it's an upstream-of-upstream
(litellm itself) limitation, not an `eval-containers` bug.


## Selective PR strategy

**Git workflow (clarified with Bruno):** `origin` in this checkout is
`git@github.com:cdoron/eval-containers.git` (a fork), current branch is
`work-branch`. There is **no** `upstream` remote configured. The actual flow:
commit each category-A fix to `cdoron/eval-containers`'s `work-branch` (or a
dedicated branch cut from it, one per fix), push to `origin`, then open a
pull request **from that branch/fork against `Exgentic/eval-containers`**
(GitHub's cross-fork PR flow — no extra `upstream` remote needed for this,
just enough that the fork is reasonably in sync with `Exgentic/main` before
opening). This supersedes the earlier "clean branch off upstream main" phrasing
below.

**Contribution shape (per `.agents/contributing/RULES.md`):** a contribution
MUST be an issue, or a PR that *resolves* an issue (principle 1) — a PR
without a linked issue doesn't satisfy this repo's own doctrine. So the
actual sequence per finding is: **open an issue on `Exgentic/eval-containers`
first** (stating the bug/gap, the repro, the suggested fix — most of that is
already written per-finding below), *then* open the PR against it. Also:
one PR MUST change either rules or code, not both (principle 2) — none of
A1–A7 require a `.agents/*/RULES.md` change (the doctrine already says what
should happen; these are all "the code doesn't yet do what the rules already
say" gaps), so each is a code-only PR, which keeps this simple.

1. Keep every category-A fix as its own isolated commit, with **no**
   category-B content mixed in (no references to `eval-containers-b`,
   `icr.io/tir-advisor-eval-containers`, or this specific cluster's storage
   class in the diff or commit message).
2. File the issue first (see above), reference it in the PR.
3. Each PR description states which rules it was checked against (principle
   3) — cite the specific `.agents/*/RULES.md` clause it satisfies or the doc
   it corrects.
4. One fix per PR/issue — e.g. the PVC namespace/storage-class
   parameterization (A1) is its own PR, not bundled with anything else found
   later.
5. Every category-A candidate is reviewed with Bruno before an issue or PR is
   opened — this file is the staging ground, not an auto-submit queue.

## Is it actually worth turning these into PRs?

Worth confronting directly: **every one of A1–A7 was worked around without
touching a single repo file** — see the "chart untouched" / "Worked around
by..." notes on each. The whole two-task pipeline (Phases 0–8 in
`README-Openshift-tested.md`) succeeded end to end using only `--set`
overrides, hand-edited rendered YAML, and env vars — zero commits to this
checkout. That's worth weighing honestly before spending review cycles on
upstream PRs, rather than assuming "we found bugs, therefore we should file
PRs."

**My take, per finding:**

- **A5 (Job name sanitization) and A7 (`report` depth cap)** — do these two
  regardless. Each is a genuinely trivial, low-risk, single-purpose diff (one
  `replace` filter in a template; one integer / an unbounded walk in Rust),
  the failure mode is unambiguous (a hard `oc apply` rejection; a silent
  "no results found" that's flatly wrong), and there's no design judgment
  call for a maintainer to make. Highest confidence, lowest cost, most
  obviously worth an issue+PR.

- **A3 (`GOSU_IMAGE` default) and A4 (`perTask` presets)** — also worth
  doing, slightly more footprint (A4 touches/creates 8 preset files; A3 is
  one default value) but still mechanical, still low risk, still no design
  ambiguity. A4 in particular is the one I'd prioritize alongside A5/A7 since
  it silently produces a *wrong, unrelated* image reference rather than an
  error — the worst kind of bug (works until it silently doesn't).

- **A2 (no `--platform` for cross-arch builds)** — real and worth reporting,
  but less trivial: it's new CLI surface (a flag, threaded through every
  `bake`-based build target), and there's a legitimate design question
  (should this also need to reach the `--builder oc` binary-BuildConfig path,
  which has its own cross-arch story?) that a maintainer should weigh in on
  before code is written. I'd file the issue with our repro and suggested
  fix, but hold off writing the PR until a maintainer confirms the intended
  shape — otherwise there's a real chance of a PR that's correct for our case
  but not the design they want.

- **A6 (`EVAL_MODEL_API` unwired)** — this is the one that actually broke our
  run, so it's the highest-*value* finding, but also the largest surface (chart
  value, CLI flag, compose var, for real parity) and the one most likely to
  need upstream discussion (naming, whether it should be a top-level
  `--model-api` flag or something else). I'd file the issue now — it's a real,
  well-evidenced functional gap — but scope any PR narrowly to just the
  Kubernetes/Helm chart wiring we actually needed and tested, flagging
  CLI/compose parity explicitly as follow-up rather than trying to land full
  parity in one PR.

- **A1 (PVC namespace/storage-class hardcoding)** — I'd deprioritize or skip
  this one. It's already marked lowest-confidence ("not yet confirmed
  necessary"), our own workaround was a two-line patch, and the OpenShift
  guide already explicitly disclaims the overlay as "a starting point to
  adapt, not a guaranteed fit for every cluster" — i.e. the maintainers may
  consider the current hardcoded example acceptable by design, and a PR here
  risks looking like unsolicited style preference rather than a bug fix.

**Net recommendation:** file issues for all seven (cheap, and the evidence is
already written), but only invest PR-writing effort in A5, A7, A3, A4 right
away; treat A2 and A6 as issues-first, PRs-after-maintainer-signal; and treat
A1 as optional/skippable unless a maintainer independently flags it as
wanted.
