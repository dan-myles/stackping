import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { StackpingConfig } from "./config.ts"

import { ConfigError, parseConfig } from "./config.ts"

export const CONFIG_FILE = "stackping.json"

export function configPath(cwd = process.cwd()): string {
  return resolve(process.env.STACKPING_CONFIG_PATH ?? resolve(cwd, CONFIG_FILE))
}

export function loadConfigFile(path = configPath()): StackpingConfig {
  if (!existsSync(path)) {
    throw new ConfigError(
      `No ${CONFIG_FILE} found at ${path}. Run \`stackping init\` to create one.`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseConfig(raw)
}
