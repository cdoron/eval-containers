//! `eval-containers run` — shell out to the right command for the chosen
//! deployment mode and pass every axis through.
//!
//! Three modes (per benchmarks/RULES.md rule 24 — the triple-mode contract):
//!
//!   --mode compose    (default) → docker compose -f containers/benchmarks/<x>/compose.yaml up
//!   --mode container            → docker run -e EVAL_MODEL=... <eval-image>-standalone (the standalone bundle)
//!   --mode job                  → helm template oci://<registry>/charts/eval | kubectl apply -f -  (--local: ./containers/benchmarks/_chart)
//!
//! Mapping flags → manifest, by mode:
//!
//!   - **compose / container** propagate every `--<flag>` through as an
//!     `EVAL_*` environment variable on the spawned subprocess. Compose
//!     interpolates `${EVAL_FOO:-default}` in compose.yaml; container
//!     mode hands them in via `docker run -e`.
//!   - **job** renders the shared Helm chart (`oci://<registry>/charts/eval`,
//!     or `containers/benchmarks/_chart` with `--local`) with a
//!     `--set` for each axis (benchmark/agent/task/model/tags), then
//!     `helm template … | kubectl apply -f -`. A benchmark's bespoke
//!     topology, if any, lives in the chart at `presets/<x>.yaml`.
//!     Helm interpolates the values (kubectl can't), keeps numeric fields
//!     like `task` quoted, and the Job name carries the agent + task so
//!     concurrent applies don't collide.
//!
//! Two axes select what runs (see RULES.md principle 9):
//!
//! - Container tag  → which image to pull (EVAL_*_TAG, flags --*-tag). Run-time.
//! - Upstream ver.  → which software is inside the image. BUILD-time only:
//!   pinned via `ARG *_VERSION`, set at `build`, recorded in the label. There
//!   is no runtime version override here.
//!
//! `--dry-run` short-circuits: compose dumps `docker compose config`,
//! container prints the resolved `docker run` line, job forwards
//! `--dry-run=server` to `kubectl apply` (exercises admission, no state).
//!
//! With `--local`, uses the in-repo `containers/benchmarks/<name>/compose.yaml`
//! (compose), the generic `containers/core/standalone.Dockerfile` built onto the
//! local lean base (container), and the local chart (job) instead of the
//! registry artifacts.

use clap::{Args, ValueEnum};
use eval_containers::naming::{agent_compose_artifact, compose_artifact};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug, ValueEnum, Default)]
pub enum Mode {
    /// One container, all 5 units inside (process-compose orchestrates).
    /// Invocation: `docker run`. The simplest surface — no orchestrator.
    Container,
    /// Three services on a compose network (otelcol + gateway + runner).
    /// Invocation: `docker compose up`. Default.
    #[default]
    Compose,
    /// One k8s `Job` + one Pod + three containers (NetworkPolicy on runner).
    /// Invocation: `kubectl apply`. Production k8s surface.
    Job,
}

#[derive(Args)]
pub struct RunArgs {
    /// Benchmark name (positional shortcut for --benchmark, maps to $EVAL_BENCHMARK)
    #[arg(value_name = "BENCHMARK")]
    benchmark_positional: Option<String>,

    /// Benchmark name (maps to $EVAL_BENCHMARK)
    #[arg(long = "benchmark")]
    benchmark_flag: Option<String>,

    /// Deployment surface to use. See benchmarks/RULES.md rule 24.
    #[arg(long, value_enum, default_value_t = Mode::Compose)]
    mode: Mode,

    /// Agent to use (maps to $EVAL_AGENT)
    #[arg(long)]
    agent: Option<String>,

    /// Model to use (maps to $EVAL_MODEL)
    #[arg(long)]
    model: Option<String>,

    /// Agent reasoning effort, e.g. `high` (maps to $EVAL_AGENT_REASONING_EFFORT)
    #[arg(long)]
    agent_reasoning_effort: Option<String>,

    /// Task ID within the benchmark (maps to $EVAL_TASK_ID)
    #[arg(long)]
    task_id: Option<String>,

    /// Text appended to the executor's system prompt.
    #[arg(long)]
    executor_system_prompt: Option<String>,

    /// Read the executor system-prompt addition from a host text file.
    #[arg(long)]
    executor_system_prompt_file: Option<PathBuf>,

    /// Named executor system prompt from --advisory-config-file.
    #[arg(long)]
    executor_system_prompt_variant: Option<String>,

    /// Named configuration catalog as inline JSON.
    #[arg(long)]
    advisory_config: Option<String>,

    /// Read the named configuration catalog from a host JSON file.
    #[arg(long)]
    advisory_config_file: Option<PathBuf>,

    /// Named advisor tool description from tool-descriptions.json.
    #[arg(long)]
    advisor_tool_description_variant: Option<String>,

    /// Custom advisor tool description; overrides the named variant.
    #[arg(long)]
    advisor_tool_description: Option<String>,

    /// Read the custom advisor tool description from a host text file.
    #[arg(long)]
    advisor_tool_description_file: Option<PathBuf>,

    /// Custom advisor system prompt.
    #[arg(long)]
    advisor_system_prompt: Option<String>,

    /// Read the advisor system prompt from a host text file.
    #[arg(long)]
    advisor_system_prompt_file: Option<PathBuf>,

    /// Named advisor system prompt from --advisory-config-file.
    #[arg(long)]
    advisor_system_prompt_variant: Option<String>,

    /// Model used by the advisor service.
    #[arg(long)]
    advisor_model: Option<String>,

    /// OpenAI-compatible endpoint used by the advisor service.
    #[arg(long)]
    advisor_base_url: Option<String>,

    /// Log advisor request/response payloads. Accepts a bare flag or =true/false.
    #[arg(long, num_args = 0..=1, default_missing_value = "true", require_equals = true)]
    advisor_log_payloads: Option<bool>,

    /// Advisor context source: agent-provided (default) or full-session.
    #[arg(long)]
    advisor_context_mode: Option<String>,

    /// Maximum serialized full-session context size in bytes; 0 means unlimited.
    #[arg(long)]
    advisor_full_context_max_bytes: Option<u64>,

    /// Experiment label attached to advisor requests.
    #[arg(long)]
    experiment_id: Option<String>,

    /// Gateway image, for example litellm or bifrost.
    #[arg(long)]
    gateway_image: Option<String>,

    // ---- Container tags (which image to pull) ----
    /// Benchmark image tag (maps to $EVAL_BENCHMARK_TAG)
    #[arg(long)]
    benchmark_tag: Option<String>,

    /// Agent image tag (maps to $EVAL_AGENT_TAG)
    #[arg(long)]
    agent_tag: Option<String>,

    /// Model image tag (maps to $EVAL_MODEL_TAG)
    #[arg(long)]
    model_tag: Option<String>,

    // NOTE: upstream versions (benchmark dataset revision, agent CLI version,
    // litellm version) are a BUILD-time axis (RULES.md principle 9): pinned via
    // `ARG *_VERSION` in each image and overridden at `build` time, not here.
    // There is no runtime override — the running version is whatever the image
    // was built with, recorded in its label.
    /// Agent timeout in seconds (maps to $EVAL_TIMEOUT)
    #[arg(long)]
    timeout: Option<u32>,

    /// Hard cap on model spend in USD for this run (maps to
    /// $EVAL_MODEL_MAX_BUDGET). The litellm proxy enforces it and
    /// returns an error once spend crosses the cap, which crashes
    /// the agent's next request. Default: $1.
    #[arg(long)]
    max_budget: Option<f64>,

    /// Use the in-repo `containers/benchmarks/<name>/` artifacts instead of the
    /// published registry artifact. For development.
    #[arg(long)]
    local: bool,

    /// Render and print what would happen — don't actually deploy. For
    /// `--mode job` this forwards `--dry-run=server` to `kubectl apply`,
    /// which exercises admission webhooks without persisting state. For
    /// `--mode compose` and `--mode container` this prints the resolved
    /// docker invocation and stops.
    #[arg(long)]
    dry_run: bool,

    /// Kubernetes namespace to target (maps to `kubectl -n <ns>`). Only
    /// applies to `--mode job`. Defaults to the current kubectl
    /// context's namespace.
    #[arg(long, short = 'n')]
    namespace: Option<String>,

    /// (`--mode job`) Layer a platform Helm values file on top of the
    /// chart values — e.g. `deploy/values-openshift.yaml`, which sets
    /// the anyuid SCC service account. Passed to helm as an extra `-f`.
    #[arg(long)]
    overlay: Option<String>,
}

/// Upstream gateway credentials forwarded into the container in single-image
/// mode (where the gateway runs in-process). Mirrors the keys the `eval-secrets`
/// Secret supplies in k8s and that `compose/services.yaml` reads from the shell.
const GATEWAY_CRED_VARS: &[&str] = &["OPENAI_API_KEY", "OPENAI_API_BASE"];

/// The shared Helm chart, published as
/// `oci://{registry}/charts/<CHART_NAME>:<CHART_VERSION>` and rendered by
/// `--mode job` (non-local). Mirrors `containers/benchmarks/_chart/Chart.yaml`
/// (`name`/`version`); the guard test below fails if they drift.
const CHART_NAME: &str = "eval";
const CHART_VERSION: &str = "0.1.0";

pub fn execute(registry: &str, args: RunArgs) -> Result<(), String> {
    // Resolve benchmark: --benchmark flag wins over positional, either must be set.
    let benchmark = args
        .benchmark_flag
        .clone()
        .or_else(|| args.benchmark_positional.clone())
        .ok_or_else(|| "benchmark required (positional or --benchmark)".to_string())?;

    let agent = args
        .agent
        .clone()
        .or_else(|| std::env::var("EVAL_AGENT").ok())
        .unwrap_or_else(|| "claude-code".to_string());
    let task_id = args
        .task_id
        .clone()
        .or_else(|| std::env::var("EVAL_TASK_ID").ok())
        .unwrap_or_else(|| "0".to_string());
    for (label, value) in [
        ("benchmark", benchmark.as_str()),
        ("agent", agent.as_str()),
        ("task id", task_id.as_str()),
    ] {
        validate_path_component(label, value)?;
    }
    let volume_name_len = 12 + benchmark.len() + agent.len() + task_id.len();
    if volume_name_len > 240 {
        return Err(
            "benchmark, agent, and task IDs are too long for the Compose output volume name".into(),
        );
    }
    let executor_system_prompt = resolve_text_source(
        "executor system prompt",
        args.executor_system_prompt.as_ref(),
        args.executor_system_prompt_file.as_ref(),
    )?;
    reject_source_conflict(
        "executor system prompt",
        executor_system_prompt.as_ref(),
        args.executor_system_prompt_variant.as_ref(),
    )?;
    let advisor_tool_description = resolve_text_source(
        "advisor tool description",
        args.advisor_tool_description.as_ref(),
        args.advisor_tool_description_file.as_ref(),
    )?;
    reject_source_conflict(
        "advisor tool description",
        advisor_tool_description.as_ref(),
        args.advisor_tool_description_variant.as_ref(),
    )?;
    let advisor_system_prompt = resolve_text_source(
        "advisor system prompt",
        args.advisor_system_prompt.as_ref(),
        args.advisor_system_prompt_file.as_ref(),
    )?;
    reject_source_conflict(
        "advisor system prompt",
        advisor_system_prompt.as_ref(),
        args.advisor_system_prompt_variant.as_ref(),
    )?;
    let advisory_config = resolve_text_source(
        "advisory configuration",
        args.advisory_config.as_ref(),
        args.advisory_config_file.as_ref(),
    )?;
    if let Some(document) = advisory_config.as_ref() {
        validate_advisory_config(document)?;
    }
    validate_advisor_context_mode(args.advisor_context_mode.as_deref())?;
    let advisor_options_supplied = args.advisor_tool_description_variant.is_some()
        || advisor_tool_description.is_some()
        || advisor_system_prompt.is_some()
        || args.advisor_system_prompt_variant.is_some()
        || executor_system_prompt.is_some()
        || args.executor_system_prompt_variant.is_some()
        || advisory_config.is_some()
        || args.advisor_model.is_some()
        || args.advisor_base_url.is_some()
        || args.advisor_log_payloads.is_some()
        || args.advisor_context_mode.is_some()
        || args.advisor_full_context_max_bytes.is_some()
        || args.experiment_id.is_some();
    if advisor_options_supplied && agent != "opencode-advisory" {
        return Err("advisor options require --agent opencode-advisory".into());
    }
    if agent == "opencode-advisory" && !matches!(args.mode, Mode::Compose) {
        return Err("opencode-advisory currently requires --mode compose for its sidecar".into());
    }

    // Build the env var set. Direct command-line flags remain the primary API;
    // experiment JSON files invoke these same flags rather than bypassing them.
    let mut envs: Vec<(&str, String)> = vec![
        ("EVAL_REGISTRY", registry.to_string()),
        ("EVAL_BENCHMARK", benchmark.clone()),
        ("EVAL_AGENT", agent.clone()),
        ("EVAL_TASK_ID", task_id.clone()),
    ];
    if let Some(ref v) = args.model {
        envs.push(("EVAL_MODEL", v.clone()));
        // The shared runner historically used EVAL_GATEWAY_LABEL for the clean
        // model label. Keep it synchronized with the CLI's --model value.
        envs.push(("EVAL_GATEWAY_LABEL", v.clone()));
    }
    if let Some(ref v) = args.agent_reasoning_effort {
        envs.push(("EVAL_AGENT_REASONING_EFFORT", v.clone()));
    }
    push_optional(
        &mut envs,
        "EVAL_EXECUTOR_SYSTEM_PROMPT",
        &executor_system_prompt,
    );
    push_optional(
        &mut envs,
        "EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT",
        &args.executor_system_prompt_variant,
    );
    push_optional(&mut envs, "EVAL_ADVISORY_CONFIG", &advisory_config);
    push_optional(
        &mut envs,
        "EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT",
        &args.advisor_tool_description_variant,
    );
    push_optional(
        &mut envs,
        "EVAL_ADVISOR_TOOL_DESCRIPTION",
        &advisor_tool_description,
    );
    push_optional(
        &mut envs,
        "EVAL_ADVISOR_SYSTEM_PROMPT",
        &advisor_system_prompt,
    );
    push_optional(
        &mut envs,
        "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT",
        &args.advisor_system_prompt_variant,
    );
    push_optional(&mut envs, "ADVISOR_MODEL", &args.advisor_model);
    push_optional(&mut envs, "ADVISOR_BASE_URL", &args.advisor_base_url);
    push_optional(
        &mut envs,
        "EVAL_ADVISOR_CONTEXT_MODE",
        &args.advisor_context_mode,
    );
    if let Some(value) = args.advisor_full_context_max_bytes {
        envs.push(("EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES", value.to_string()));
    }
    push_optional(&mut envs, "ADVISORY_EXPERIMENT_ID", &args.experiment_id);
    push_optional(&mut envs, "EVAL_GATEWAY_IMAGE", &args.gateway_image);
    if let Some(value) = args.advisor_log_payloads {
        envs.push(("ADVISOR_LOG_PAYLOADS", value.to_string()));
    }

    // Container tags
    if let Some(ref v) = args.benchmark_tag {
        envs.push(("EVAL_BENCHMARK_TAG", v.clone()));
    }
    if let Some(ref v) = args.agent_tag {
        envs.push(("EVAL_AGENT_TAG", v.clone()));
    }
    if let Some(ref v) = args.model_tag {
        envs.push(("EVAL_MODEL_TAG", v.clone()));
    }

    if let Some(timeout) = args.timeout {
        envs.push(("EVAL_TIMEOUT", timeout.to_string()));
    }
    if let Some(budget) = args.max_budget {
        envs.push(("EVAL_MODEL_MAX_BUDGET", budget.to_string()));
    }

    if args.overlay.is_some() && !matches!(args.mode, Mode::Job) {
        return Err("--overlay applies only to `--mode job`".into());
    }

    match args.mode {
        Mode::Compose => run_compose(
            registry,
            &benchmark,
            &agent,
            &envs,
            args.local,
            args.dry_run,
        ),
        Mode::Container => run_container(
            registry,
            &benchmark,
            &agent,
            &envs,
            args.local,
            args.dry_run,
        ),
        Mode::Job => run_job(registry, &benchmark, &args),
    }
}

fn push_optional<'a>(envs: &mut Vec<(&'a str, String)>, key: &'a str, value: &Option<String>) {
    if let Some(value) = value {
        envs.push((key, value.clone()));
    }
}

fn resolve_text_source(
    label: &str,
    inline: Option<&String>,
    file: Option<&PathBuf>,
) -> Result<Option<String>, String> {
    if inline.is_some() && file.is_some() {
        return Err(format!(
            "choose either inline {label} text or a {label} file, not both"
        ));
    }
    let value = match (inline, file) {
        (Some(value), None) => Some(value.clone()),
        (None, Some(path)) => Some(
            fs::read_to_string(path)
                .map_err(|e| format!("failed to read {label} file '{}': {e}", path.display()))?,
        ),
        (None, None) => None,
        (Some(_), Some(_)) => unreachable!(),
    };
    if value.as_deref().is_some_and(|text| text.trim().is_empty()) {
        return Err(format!("{label} must not be empty"));
    }
    Ok(value)
}

fn reject_source_conflict(
    label: &str,
    direct: Option<&String>,
    variant: Option<&String>,
) -> Result<(), String> {
    if direct.is_some() && variant.is_some() {
        return Err(format!(
            "choose either direct {label} text or a named {label} variant, not both"
        ));
    }
    Ok(())
}

fn validate_advisory_config(document: &str) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(document)
        .map_err(|e| format!("advisory configuration is not valid JSON: {e}"))?;
    let catalog = parsed
        .as_object()
        .ok_or_else(|| "advisory configuration must be a JSON object".to_string())?;
    let allowed = [
        "executor_system_prompts",
        "advisor_system_prompts",
        "tool_descriptions",
    ];
    for (section, entries) in catalog {
        if !allowed.contains(&section.as_str()) {
            return Err(format!(
                "unknown advisory configuration section '{section}'"
            ));
        }
        let entries = entries.as_object().ok_or_else(|| {
            format!("advisory configuration section '{section}' must be an object")
        })?;
        for (name, value) in entries {
            if value.as_str().is_none_or(|text| text.trim().is_empty()) {
                return Err(format!(
                    "advisory configuration entry '{section}.{name}' must be a non-empty string"
                ));
            }
        }
    }
    Ok(())
}

fn validate_advisor_context_mode(value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|value| !matches!(value, "agent-provided" | "full-session")) {
        return Err("advisor context mode must be 'agent-provided' or 'full-session'".into());
    }
    Ok(())
}

fn validate_path_component(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(format!(
            "invalid {label} '{value}': use only letters, numbers, '.', '_', or '-'"
        ));
    }
    Ok(())
}

fn env_value<'a>(envs: &'a [(&str, String)], key: &str, default: &'a str) -> &'a str {
    envs.iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value.as_str())
        .unwrap_or(default)
}

fn output_dir(benchmark: &str, agent: &str, envs: &[(&str, String)]) -> PathBuf {
    Path::new("output")
        .join(benchmark)
        .join(agent)
        .join(env_value(envs, "EVAL_TASK_ID", "0"))
}

fn prepare_output_dir(
    benchmark: &str,
    agent: &str,
    envs: &[(&str, String)],
) -> Result<PathBuf, String> {
    let dir = output_dir(benchmark, agent, envs);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| {
            format!(
                "failed to replace existing task output '{}': {e}",
                dir.display()
            )
        })?;
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create host output dir '{}': {e}", dir.display()))?;

    let mut safe = serde_json::Map::new();
    for key in [
        "EVAL_BENCHMARK",
        "EVAL_AGENT",
        "EVAL_MODEL",
        "EVAL_TASK_ID",
        "EVAL_TIMEOUT",
        "EVAL_MODEL_MAX_BUDGET",
        "EVAL_AGENT_REASONING_EFFORT",
        "EVAL_EXECUTOR_SYSTEM_PROMPT",
        "EVAL_EXECUTOR_SYSTEM_PROMPT_VARIANT",
        "EVAL_ADVISORY_CONFIG",
        "EVAL_GATEWAY_IMAGE",
        "EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT",
        "EVAL_ADVISOR_TOOL_DESCRIPTION",
        "EVAL_ADVISOR_SYSTEM_PROMPT",
        "EVAL_ADVISOR_SYSTEM_PROMPT_VARIANT",
        "EVAL_ADVISOR_CONTEXT_MODE",
        "EVAL_ADVISOR_FULL_CONTEXT_MAX_BYTES",
        "ADVISOR_MODEL",
        "ADVISORY_EXPERIMENT_ID",
        "ADVISOR_LOG_PAYLOADS",
    ] {
        if let Some((_, value)) = envs.iter().find(|(name, _)| *name == key) {
            safe.insert(key.to_string(), Value::String(value.clone()));
        }
    }
    // ADVISOR_BASE_URL is deliberately excluded because URLs can contain
    // embedded credentials. API keys are never included in envs or manifests.
    let rendered = serde_json::to_string_pretty(&Value::Object(safe))
        .map_err(|e| format!("failed to serialize run config: {e}"))?;
    fs::write(dir.join("config.json"), format!("{rendered}\n"))
        .map_err(|e| format!("failed to write run config: {e}"))?;
    Ok(dir)
}

fn read_json_or_null(path: PathBuf) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn value_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn append_benchmark_result(
    benchmark: &str,
    dir: &Path,
    orchestrator_ok: bool,
) -> Result<(), String> {
    append_benchmark_result_to(Path::new("output"), benchmark, dir, orchestrator_ok)
}

fn append_benchmark_result_to(
    output_root: &Path,
    benchmark: &str,
    dir: &Path,
    orchestrator_ok: bool,
) -> Result<(), String> {
    fs::write(
        dir.join("orchestrator.json"),
        format!("{}\n", json!({"orchestrator_ok": orchestrator_ok})),
    )
    .map_err(|e| format!("failed to write runtime status: {e}"))?;

    let benchmark_dir = output_root.join(benchmark);
    let task = read_json_or_null(dir.join("task/result.json"));
    let agent_result = read_json_or_null(dir.join("agent/result.json"));
    let model_result = read_json_or_null(dir.join("model/result.json"));
    let config = read_json_or_null(dir.join("config.json"));
    let record = json!({
        "benchmark": value_string(&task, "benchmark").unwrap_or(benchmark),
        "task_id": value_string(&task, "task_id")
            .or_else(|| value_string(&config, "EVAL_TASK_ID"))
            .unwrap_or("unknown"),
        "agent": value_string(&agent_result, "agent")
            .or_else(|| value_string(&config, "EVAL_AGENT"))
            .unwrap_or("unknown"),
        "executor_model": value_string(&model_result, "model")
            .or_else(|| value_string(&config, "EVAL_MODEL"))
            .unwrap_or("unknown"),
        "orchestrator_ok": orchestrator_ok,
        "output_dir": dir.to_string_lossy(),
        "task": task,
        "agent_result": agent_result,
        "model_result": model_result,
        "config": config,
    });
    let index = benchmark_dir.join("results.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index)
        .map_err(|e| format!("failed to open results history '{}': {e}", index.display()))?;
    writeln!(file, "{record}").map_err(|e| {
        format!(
            "failed to append results history '{}': {e}",
            index.display()
        )
    })
}

/// `--mode compose` → docker compose -f compose.yaml up
fn run_compose(
    registry: &str,
    benchmark: &str,
    agent: &str,
    envs: &[(&str, String)],
    local: bool,
    dry_run: bool,
) -> Result<(), String> {
    let compose_ref = if local {
        format!("./containers/benchmarks/{benchmark}/compose.yaml")
    } else {
        format!("oci://{}", compose_artifact(registry, benchmark))
    };
    let overlay_ref = (agent == "opencode-advisory").then(|| {
        if local {
            "./containers/agents/opencode-advisory/compose.yaml".to_string()
        } else {
            format!("oci://{}", agent_compose_artifact(registry, agent))
        }
    });
    let project_directory = overlay_ref
        .as_ref()
        .filter(|_| local)
        .map(|_| format!("./containers/benchmarks/{benchmark}"));
    let env_str = envs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    let project_arg = project_directory
        .as_ref()
        .map(|dir| format!(" --project-directory {dir}"))
        .unwrap_or_default();
    let overlay_arg = overlay_ref
        .as_ref()
        .map(|overlay| format!(" -f {overlay}"))
        .unwrap_or_default();
    eprintln!(
        "$ {env_str} docker compose{project_arg}{overlay_arg} -f {compose_ref} up -y --abort-on-container-exit"
    );
    if dry_run {
        // For compose, dry-run means show the resolved manifest (which
        // includes all `${EVAL_*:-default}` interpolations) and stop.
        // `docker compose config` is the canonical render command.
        eprintln!("(--dry-run: showing resolved compose config, not running)");
        let mut cmd = Command::new("docker");
        cmd.arg("compose");
        if let Some(dir) = &project_directory {
            cmd.arg("--project-directory").arg(dir);
        }
        if let Some(overlay) = &overlay_ref {
            cmd.arg("-f").arg(overlay);
        }
        cmd.arg("-f").arg(&compose_ref).arg("config");
        for (k, v) in envs {
            cmd.env(k, v);
        }
        let status = cmd
            .status()
            .map_err(|e| format!("failed to run docker compose config: {e}"))?;
        if !status.success() {
            return Err(format!("docker compose config failed with {status}"));
        }
        return Ok(());
    }

    // `services.yaml` binds to ./output/{benchmark}/{agent}/{task}.
    // (compose/RULES.md rule 18) via a `driver_opts.device:` path — unlike a
    // short-syntax host bind, that form does not auto-create the directory,
    // so pre-create it here (as the invoking user, so the agent's uid-1002
    // process can still write into it — Docker would otherwise make it
    // root-owned on first mount).
    let output_dir = prepare_output_dir(benchmark, agent, envs)?;

    let mut cmd = Command::new("docker");
    cmd.arg("compose");
    if let Some(dir) = &project_directory {
        cmd.arg("--project-directory").arg(dir);
    }
    if let Some(overlay) = &overlay_ref {
        cmd.arg("-f").arg(overlay);
    }
    cmd.arg("-f").arg(&compose_ref);
    // `-y`: a published `oci://` stack prompts to confirm (and echoes) the
    // variables it injects; assume yes so the run stays non-interactive.
    cmd.arg("up").arg("-y").arg("--abort-on-container-exit");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let status = cmd
        .status()
        .map_err(|e| format!("failed to run docker compose: {e}"))?;
    append_benchmark_result(benchmark, &output_dir, status.success())?;
    if !status.success() {
        return Err(format!("docker compose failed with {status}"));
    }
    Ok(())
}

/// `--mode container` → docker run -e ... <eval-image>-standalone
///
/// Container mode runs the single-container **standalone bundle**
/// (`evals/<b>--<a>-standalone:<version>`): the lean eval base + the in-process
/// gateway/otelcol/process-compose. The variant is a name suffix, not a tag (the
/// tag is the version). Non-local pulls the registry-published `-standalone`
/// image; `--local` builds it from the one generic `core/standalone.Dockerfile`,
/// layering onto the lean base (`evals/<b>--<a>:latest`, produced by `build eval`)
/// supplied as the `eval-base` build context
/// (`--build-context eval-base=docker-image://…`). There is no per-benchmark
/// Dockerfile.
fn run_container(
    registry: &str,
    benchmark: &str,
    agent: &str,
    envs: &[(&str, String)],
    local: bool,
    dry_run: bool,
) -> Result<(), String> {
    // Per-task benchmarks bake one eval image per task: the bundle layers onto the
    // task-aware lean base (evals/<b>-<task>--<a>). Shared-env benchmarks use the
    // task-less name. Per-task resolution lives in the eval-base build context,
    // not a per-benchmark stub. (benchmarks/RULES.md 24a / 24f.)
    let task_id = envs
        .iter()
        .find(|(k, _)| *k == "EVAL_TASK_ID")
        .map(|(_, v)| v.clone());
    let per_task = eval_containers::benchmark::is_per_task_by_name(benchmark);
    if per_task && task_id.is_none() {
        return Err(format!(
            "{benchmark} is a per-task benchmark — pass --task-id <id> in container mode"
        ));
    }
    // The single-container standalone bundle image — what `docker run` launches,
    // the same name whether built locally or pulled. Per-task gets the task-aware
    // name (the helper lowercases the task id for Docker). (benchmarks/RULES.md 24f.)
    let image = match (per_task, task_id.as_deref()) {
        (true, Some(t)) => eval_containers::naming::eval_task_standalone_image(
            registry, benchmark, t, agent, "latest",
        ),
        _ => eval_containers::naming::eval_standalone_image(registry, benchmark, agent, "latest"),
    };
    if local {
        // Build the bundle by layering the in-process gateway/otelcol/process-
        // compose onto the lean base that `build eval` produced. The lean base is
        // supplied as the `eval-base` build CONTEXT (standalone.Dockerfile is
        // `FROM eval-base`) — a named context binds `FROM eval-base` to a concrete
        // image where an ARG-based FROM does not; per-task resolution lives in that
        // ref. The build's context dir + dockerfile come from the `eval-standalone`
        // bake target (read via bake --print), not hardcoded — bake stays the
        // single source of truth; we override only the eval-base context here.
        let combination = match (per_task, task_id.as_deref()) {
            (true, Some(t)) => {
                eval_containers::naming::eval_task_image(registry, benchmark, t, agent, "latest")
            }
            _ => eval_containers::naming::eval_image(registry, benchmark, agent, "latest"),
        };
        let spec = crate::build::bake_print(
            "eval-standalone",
            &[],
            registry,
            &[
                ("EVAL_BENCHMARK", benchmark.to_string()),
                ("EVAL_AGENT", agent.to_string()),
                ("BENCHMARK_IMAGE", combination.clone()),
                ("AGENT_IMAGE", combination.clone()),
            ],
        )?;
        let context = spec
            .context
            .as_deref()
            .unwrap_or("containers/core")
            .to_string();
        // bake reports `dockerfile` relative to `context`; `docker build -f` wants
        // it relative to CWD, so join them.
        let dockerfile = match spec.dockerfile.as_deref() {
            Some(df) => format!("{context}/{df}"),
            None => "containers/core/standalone.Dockerfile".to_string(),
        };
        eprintln!(
            "$ docker build -f {dockerfile} --build-context eval-base=docker-image://{combination} -t {image} {context}"
        );
        let mut build = Command::new("docker");
        build.arg("build").arg("-f").arg(dockerfile);
        build
            .arg("--build-context")
            .arg(format!("eval-base=docker-image://{combination}"));
        build.arg("-t").arg(&image).arg(context);
        let status = build
            .status()
            .map_err(|e| format!("failed to docker build: {e}"))?;
        if !status.success() {
            return Err(format!("docker build failed with {status}"));
        }
    }

    let env_str = envs
        .iter()
        .map(|(k, v)| format!("-e {k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    let output_dir = output_dir(benchmark, agent, envs);
    eprintln!(
        "$ docker run --rm {env_str} -v {}:/output {image}",
        output_dir.display()
    );
    if dry_run {
        eprintln!("(--dry-run: stopping before docker run)");
        return Ok(());
    }

    let output_dir = prepare_output_dir(benchmark, agent, envs)?;
    let absolute_output = std::env::current_dir()
        .map_err(|e| format!("failed to resolve current directory: {e}"))?
        .join(&output_dir);
    let mut cmd = Command::new("docker");
    cmd.arg("run").arg("--rm");
    for (k, v) in envs {
        cmd.arg("-e").arg(format!("{k}={v}"));
    }
    // Single-image mode runs the gateway in-container, so it needs the upstream
    // credentials the gateway service gets from `eval-secrets` (k8s) or the
    // shell env (compose). Forward them from the caller's environment with
    // docker's `-e NAME` passthrough (no value → not rendered into logs); unset
    // vars are skipped, so this is a no-op when the caller didn't provide them.
    for var in GATEWAY_CRED_VARS {
        if std::env::var_os(var).is_some() {
            cmd.arg("-e").arg(var);
        }
    }
    cmd.arg("-v")
        .arg(format!("{}:/output", absolute_output.display()));
    cmd.arg(&image);
    let status = cmd
        .status()
        .map_err(|e| format!("failed to docker run: {e}"))?;
    append_benchmark_result(benchmark, &output_dir, status.success())?;
    if !status.success() {
        return Err(format!("docker run failed with {status}"));
    }
    Ok(())
}

/// `--mode job` → `helm template oci://<registry>/charts/eval … | kubectl apply -f -`
/// (or `./benchmarks/_chart` with `--local`).
///
/// The shared chart (`benchmarks/_chart`) renders the otelcol+gateway+runner
/// Job; the axes (benchmark/agent/task/model/tags/versions) come in via `--set`,
/// and a benchmark's bespoke topology (if any) from the chart's
/// `presets/<x>.yaml`. Platform composition (e.g. the OpenShift
/// anyuid SCC) layers in as an extra `-f <values>` via `--overlay`. Helm fills
/// the values, keeps numeric fields (task) quoted, and leaves the runner
/// command's `$?`/`$rc` untouched — no kustomize overlay to synthesize.
/// See .agents/benchmarks/RULES.md.
///
/// Cluster `eval-secrets` Secret still provides upstream credentials.
fn run_job(registry: &str, benchmark: &str, args: &RunArgs) -> Result<(), String> {
    let agent = args.agent.as_deref().unwrap_or("claude-code");
    let task = args.task_id.as_deref().unwrap_or("0");

    // Chart source mirrors compose/container: `--local` renders the in-repo
    // chart; otherwise pull the published OCI chart so `--mode job` needs no repo
    // checkout (src/RULES.md principle 8 registry-aware, principle 9 local-first).
    let chart = if args.local {
        let local = "./containers/benchmarks/_chart".to_string();
        if !std::path::Path::new(&local).exists() {
            return Err(
                "--local needs ./containers/benchmarks/_chart; run from the repo root".into(),
            );
        }
        local
    } else {
        format!("oci://{registry}/charts/{CHART_NAME}")
    };

    // helm template <release> <chart> [--version <v>] [-f <overlay>] --set benchmark=… …
    // The benchmark is named via --set; its bespoke topology (if any) lives in
    // the chart at presets/<benchmark>.yaml, so no per-benchmark file is passed.
    // The release name is a DNS-1123 label (Helm forbids `_`); per-task task ids
    // carry forbidden chars (SWE-bench's `sympy__sympy-24066`), so sanitize it or
    // `--mode job` can't render for per-task benchmarks (benchmarks/RULES.md 24f).
    let release =
        eval_containers::naming::release_name(&format!("{benchmark}-{agent}-task-{task}"));
    let mut helm: Vec<String> = vec!["template".into(), release, chart];
    // OCI charts are versioned; pin the published version (the `--local` dir needs none).
    if !args.local {
        helm.push("--version".into());
        helm.push(CHART_VERSION.into());
    }

    // Platform composition: --overlay points at a Helm values file (e.g.
    // deploy/values-openshift.yaml), layered on top of the chart values.
    if let Some(ov) = &args.overlay {
        if !std::path::Path::new(ov).exists() {
            return Err(format!(
                "overlay values file not found: {ov} (a platform overlay is now a \
                 Helm values file, e.g. deploy/values-openshift.yaml)"
            ));
        }
        helm.push("-f".into());
        helm.push(ov.clone());
    }

    // Runtime axes → --set (one each, so values containing commas are safe).
    // --model is the <provider>/<model> handle → the gateway's EVAL_MODEL; the
    // chart derives the runner's clean MODEL label from it (last path segment).
    let mut sets: Vec<String> = vec![
        format!("benchmark={benchmark}"),
        format!("registry={registry}"),
        format!("agent={agent}"),
        format!("task={task}"),
    ];
    // Per-task benchmarks bake one eval image per task, so the chart must render
    // the task-aware runner image (evals/<b>-<task>--<a>). Each runs as one Job
    // per task — they can't use the Indexed dataset Job (one image × N indices);
    // the chart enforces that with a perTask+datasetSize guard. (benchmarks/RULES.md.)
    if eval_containers::benchmark::is_per_task_by_name(benchmark) {
        sets.push("perTask=true".into());
    }
    if let Some(m) = &args.model {
        sets.push(format!("model={m}"));
    }
    if let Some(e) = &args.agent_reasoning_effort {
        sets.push(format!("reasoningEffort={e}"));
    }
    if let Some(image) = &args.gateway_image {
        sets.push(format!("gatewayImage={image}"));
    }
    if let Some(t) = args.timeout {
        sets.push(format!("timeout={t}"));
    }
    if let Some(t) = &args.model_tag {
        sets.push(format!("gatewayTag={t}"));
    }
    // The combined runner image is produced per-agent, so --agent-tag wins over
    // --benchmark-tag when both are set.
    if let Some(t) = args.agent_tag.as_ref().or(args.benchmark_tag.as_ref()) {
        sets.push(format!("runnerTag={t}"));
    }
    if let Some(b) = args.max_budget {
        sets.push(format!("maxBudget={b}"));
    }
    for s in &sets {
        helm.push("--set".into());
        helm.push(s.clone());
    }

    // kubectl apply [-n ns] [--dry-run=server] -f -
    let mut apply_args: Vec<String> = vec!["apply".into()];
    if args.dry_run {
        apply_args.push("--dry-run=server".into());
    }
    if let Some(ns) = &args.namespace {
        apply_args.push("-n".into());
        apply_args.push(ns.clone());
    }

    eprintln!(
        "$ helm {} | kubectl {} -f -",
        helm.join(" "),
        apply_args.join(" ")
    );
    eprintln!("(Note: cluster needs `eval-secrets` Secret with OPENAI_API_KEY+OPENAI_API_BASE.)");

    let helm_out = Command::new("helm")
        .args(&helm)
        .output()
        .map_err(|e| format!("failed to run helm template (is helm installed?): {e}"))?;
    if !helm_out.status.success() {
        return Err(format!(
            "helm template failed: {}",
            String::from_utf8_lossy(&helm_out.stderr)
        ));
    }

    use std::process::Stdio;
    let mut apply_cmd = Command::new("kubectl");
    for a in &apply_args {
        apply_cmd.arg(a);
    }
    apply_cmd.args(["-f", "-"]);
    let mut apply = apply_cmd
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn kubectl apply: {e}"))?;
    {
        use std::io::Write;
        apply
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&helm_out.stdout)
            .map_err(|e| format!("failed to pipe manifest to kubectl apply: {e}"))?;
    }
    let status = apply
        .wait()
        .map_err(|e| format!("failed to wait on kubectl apply: {e}"))?;
    if !status.success() {
        return Err(format!("kubectl apply failed with {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        CHART_NAME, CHART_VERSION, append_benchmark_result_to, output_dir, reject_source_conflict,
        resolve_text_source, validate_advisor_context_mode, validate_advisory_config,
        validate_path_component,
    };

    #[test]
    fn direct_prompt_sources_are_exclusive() {
        let inline = "inline".to_string();
        let variant = "named".to_string();
        assert_eq!(
            resolve_text_source("prompt", Some(&inline), None).unwrap(),
            Some(inline.clone())
        );
        assert!(reject_source_conflict("prompt", Some(&inline), Some(&variant)).is_err());
    }

    #[test]
    fn advisory_catalog_requires_named_string_maps() {
        assert!(
            validate_advisory_config(r#"{"advisor_system_prompts":{"concise":"Be concise."}}"#)
                .is_ok()
        );
        assert!(validate_advisory_config(r#"{"advisor_system_prompts":[]}"#).is_err());
        assert!(validate_advisory_config(r#"{"unknown":{"x":"y"}}"#).is_err());
    }

    #[test]
    fn advisor_context_mode_accepts_only_supported_values() {
        assert!(validate_advisor_context_mode(None).is_ok());
        assert!(validate_advisor_context_mode(Some("agent-provided")).is_ok());
        assert!(validate_advisor_context_mode(Some("full-session")).is_ok());
        assert!(validate_advisor_context_mode(Some("summary")).is_err());
    }

    #[test]
    fn output_path_contains_benchmark_agent_and_task() {
        let envs = [("EVAL_TASK_ID", "task-7".to_string())];
        assert_eq!(
            output_dir("appworld", "opencode-advisory", &envs),
            std::path::Path::new("output/appworld/opencode-advisory/task-7")
        );
    }

    #[test]
    fn output_path_components_reject_traversal() {
        assert!(validate_path_component("task id", "../old-task").is_err());
        assert!(validate_path_component("task id", "safe_task-1.2").is_ok());
    }

    #[test]
    fn benchmark_history_appends_result_and_config() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "eval-containers-history-{}-{suffix}",
            std::process::id()
        ));
        let task_dir = root.join("appworld/opencode-advisory/6");
        std::fs::create_dir_all(task_dir.join("task")).expect("create task output");
        std::fs::create_dir_all(task_dir.join("agent")).expect("create agent output");
        std::fs::create_dir_all(task_dir.join("model")).expect("create model output");
        std::fs::write(
            task_dir.join("task/result.json"),
            r#"{"task_id":"6","benchmark":"appworld","reward":1,"passed":true}"#,
        )
        .expect("write task result");
        std::fs::write(
            task_dir.join("agent/result.json"),
            r#"{"agent":"opencode-advisory"}"#,
        )
        .expect("write agent result");
        std::fs::write(
            task_dir.join("model/result.json"),
            r#"{"model":"aws/claude-haiku-4-5"}"#,
        )
        .expect("write model result");
        std::fs::write(
            task_dir.join("config.json"),
            r#"{"EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT":"neutral"}"#,
        )
        .expect("write config");

        append_benchmark_result_to(&root, "appworld", &task_dir, true)
            .expect("append first result");
        append_benchmark_result_to(&root, "appworld", &task_dir, false)
            .expect("append second result");

        let history =
            std::fs::read_to_string(root.join("appworld/results.jsonl")).expect("read history");
        let records: Vec<serde_json::Value> = history
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid history JSON"))
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["orchestrator_ok"], true);
        assert_eq!(records[1]["orchestrator_ok"], false);
        assert_eq!(
            records[0]["config"]["EVAL_ADVISOR_TOOL_DESCRIPTION_VARIANT"],
            "neutral"
        );
        std::fs::remove_dir_all(root).expect("remove test output");
    }

    // `--mode job` (non-local) renders `oci://…/charts/{CHART_NAME}` pinned to
    // {CHART_VERSION}; both MUST track benchmarks/_chart/Chart.yaml, or the
    // published chart and the CLI silently drift apart.
    #[test]
    fn chart_consts_match_chart_yaml() {
        let yaml = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../containers/benchmarks/_chart/Chart.yaml"
        ))
        .expect("read containers/benchmarks/_chart/Chart.yaml");
        assert!(
            yaml.lines()
                .any(|l| l.trim() == format!("name: {CHART_NAME}")),
            "CHART_NAME ({CHART_NAME}) must match Chart.yaml `name`"
        );
        assert!(
            yaml.lines()
                .any(|l| l.trim() == format!("version: {CHART_VERSION}")),
            "CHART_VERSION ({CHART_VERSION}) must match Chart.yaml `version`"
        );
    }
}
