import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

/** Local, gitignored file holding the values `stackping deploy` needs. */
export const SECRETS_FILE = ".env.stackping"

export const SECRET_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "STACKPING_GITHUB_TOKEN",
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]
export type Secrets = Partial<Record<SecretKey, string>>

export function readSecrets(dir: string): Secrets {
  const path = join(dir, SECRETS_FILE)
  const fromFile: Secrets = {}
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      const [, key, raw] = match
      if ((SECRET_KEYS as ReadonlyArray<string>).includes(key!)) {
        fromFile[key as SecretKey] = raw!.replace(/^["']|["']$/g, "")
      }
    }
  }
  // The environment wins, so CI can deploy without the file.
  const merged: Secrets = { ...fromFile }
  for (const key of SECRET_KEYS) {
    const value = process.env[key]
    if (value) merged[key] = value
  }
  return merged
}

export function writeSecrets(dir: string, secrets: Secrets): void {
  const path = join(dir, SECRETS_FILE)
  const lines = [
    "# stackping deploy secrets. Do not commit this file.",
    ...SECRET_KEYS.filter((key) => secrets[key]).map(
      (key) => `${key}=${secrets[key]}`,
    ),
    "",
  ]
  writeFileSync(path, lines.join("\n"), { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Makes sure local-only files never get committed. */
export function ensureGitignore(dir: string): void {
  const path = join(dir, ".gitignore")
  const wanted = [SECRETS_FILE, ".alchemy/"]
  const current = existsSync(path) ? readFileSync(path, "utf8") : ""
  const missing = wanted.filter(
    (entry) => !current.split("\n").some((line) => line.trim() === entry),
  )
  if (missing.length === 0) return
  const prefix = current && !current.endsWith("\n") ? "\n" : ""
  appendFileSync(path, `${prefix}${missing.join("\n")}\n`)
}
