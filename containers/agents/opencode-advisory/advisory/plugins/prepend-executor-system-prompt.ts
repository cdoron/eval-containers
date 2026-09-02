import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs"

const PROMPT_FILE = "/home/agent/.config/opencode/executor-system-prompt.txt"

export const PrependExecutorSystemPrompt: Plugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    if (!input.sessionID) return
    const prompt = fs.readFileSync(PROMPT_FILE, "utf8").trim()
    if (!prompt) return
    output.system.splice(0, output.system.length, `${prompt}\n\n${output.system.join("\n\n")}`)
  },
})
