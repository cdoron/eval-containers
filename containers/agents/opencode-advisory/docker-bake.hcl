target "agent-opencode-advisory" {
  context = "containers/agents/opencode-advisory"
  contexts = {
    "${REGISTRY}/core/agent-base-node" = "target:agent-base-node"
  }
  tags = ["${REGISTRY}/agents/opencode-advisory:${TAG}"]
}
