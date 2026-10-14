#!/usr/bin/env bun
/**
 * Sends a signed GitHub webhook to a running stackping Worker, for local
 * development against `alchemy dev`.
 *
 *   bun scripts/replay.ts <event> <payload.json> [--url http://localhost:1337] [--stage dev]
 *
 * The signing secret comes from --secret, $GITHUB_WEBHOOK_SECRET, or the
 * local Alchemy state for the stage (STACKPING_STATE=local).
 */
import { existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { hmacSha256Hex } from "../src/domain/github.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://localhost:1337" },
    stage: { type: "string", default: "dev" },
    secret: { type: "string" },
  },
})

const [event, file] = positionals
if (!event || !file) {
  console.error(
    "usage: bun scripts/replay.ts <event> <payload.json> [--url] [--stage] [--secret]",
  )
  process.exit(1)
}

function localSecret(stage: string): string | undefined {
  const path = `.alchemy/state/stackping/${stage}/GitHubWebhookSecret.json`
  if (!existsSync(path)) return undefined
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    attr?: { text?: { __redacted__?: string } }
  }
  return state.attr?.text?.__redacted__
}

const secret =
  values.secret ??
  process.env.GITHUB_WEBHOOK_SECRET ??
  localSecret(values.stage!)
if (!secret) {
  console.error(
    "No webhook secret: pass --secret or run alchemy dev with STACKPING_STATE=local",
  )
  process.exit(1)
}

const body = readFileSync(file, "utf8")
const response = await fetch(`${values.url}/webhooks/github`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": crypto.randomUUID(),
    "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, body)}`,
  },
  body,
})
console.log(response.status, await response.text())
