import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Secrets } from "./secrets.ts"

/** The stackping package root (holds alchemy.run.ts). */
export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url))
export const STACK_ENTRY = join(PACKAGE_ROOT, "alchemy.run.ts")

/** Alchemy's CLI from stackping's own pinned dependency, never a global one. */
function alchemyCli(): string {
  let dir = dirname(Bun.resolveSync("alchemy", PACKAGE_ROOT))
  while (!existsSync(join(dir, "bin", "cli.js"))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error("Could not locate the alchemy CLI")
    dir = parent
  }
  return join(dir, "bin", "cli.js")
}

export interface AlchemyRun {
  readonly code: number
  /** The deployed Worker URL, when the run printed stack outputs. */
  readonly url: string | null
}

/**
 * Runs an Alchemy command against stackping's stack with the user's config
 * and secrets. Output streams through; the Worker URL is captured from it.
 */
export function runAlchemy(
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly configPath: string
    readonly secrets?: Secrets
    readonly env?: Record<string, string>
  },
): Promise<AlchemyRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [alchemyCli(), ...args, "--config", STACK_ENTRY],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.secrets,
          ...options.env,
          STACKPING_CONFIG_PATH: options.configPath,
          DO_NOT_TRACK: process.env.DO_NOT_TRACK ?? "1",
        },
        stdio: ["inherit", "pipe", "inherit"],
      },
    )
    let url: string | null = null
    let buffer = ""
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk)
      buffer = (buffer + chunk.toString()).slice(-8_192)
      const match = /url:\s*['"](https?:\/\/[^'"]+)['"]/.exec(buffer)
      if (match) url = match[1]!
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, url }))
  })
}

/** Runs an Alchemy command interactively (for logins that need a browser). */
export function runAlchemyInteractive(
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly configPath: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [alchemyCli(), ...args, "--config", STACK_ENTRY],
      {
        cwd: options.cwd,
        env: { ...process.env, STACKPING_CONFIG_PATH: options.configPath },
        stdio: "inherit",
      },
    )
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

/** Whether Alchemy can already reach Cloudflare without a login prompt. */
export function hasCloudflareCredentials(): boolean {
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY) {
    return true
  }
  const home = process.env.ALCHEMY_HOME ?? join(homedir(), ".alchemy")
  const profile = process.env.ALCHEMY_PROFILE ?? "default"
  return existsSync(join(home, "profiles", profile, "cloudflare.json"))
}
