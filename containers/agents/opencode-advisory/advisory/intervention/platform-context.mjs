"use strict"

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { isAutomatedAdvisorCallID } from "./protocol.mjs"

const CONTEXT_DIRECTORY = "/tmp/opencode-advisory-platform-context"

function contextPath(callID) {
  if (!isAutomatedAdvisorCallID(callID) || !/^[A-Za-z0-9_-]+$/.test(callID)) {
    throw new Error("invalid platform advisor call id")
  }
  return path.join(CONTEXT_DIRECTORY, `${callID}.json`)
}

export function writePlatformAdvisorContext(callID, context) {
  if (typeof context !== "string" || !context.trim()) {
    throw new Error("platform advisor context must be non-empty")
  }
  fs.mkdirSync(CONTEXT_DIRECTORY, { recursive: true, mode: 0o700 })
  const destination = contextPath(callID)
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, context, { encoding: "utf8", flag: "wx", mode: 0o600 })
  fs.renameSync(temporary, destination)
}

export function takePlatformAdvisorContext(callID) {
  const source = contextPath(callID)
  try {
    const context = fs.readFileSync(source, "utf8")
    fs.unlinkSync(source)
    return context
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}
