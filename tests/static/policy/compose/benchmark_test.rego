package main

import rego.v1

tagged := {
	"include": [{"path": "../../compose/services.yaml"}],
	"services": {
		"runner": {
			"image": "registry/evals/aime--agent:${EVAL_AGENT_TAG:-${EVAL_BENCHMARK_TAG:-latest}}",
			"environment": {"BENCHMARK": "aime"},
		},
	},
}

hardcoded := {
	"include": [{"path": "../../compose/services.yaml"}],
	"services": {
		"runner": {
			"image": "registry/evals/aime--agent:latest",
			"environment": {"BENCHMARK": "aime"},
		},
	},
}

test_runner_accepts_both_tag_axes if {
	count(deny) == 0 with input as tagged
}

test_runner_rejects_a_hardcoded_tag if {
	count(deny) == 1 with input as hardcoded
}
