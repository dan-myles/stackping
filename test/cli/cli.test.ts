import { afterEach, describe, expect, it } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAppUrl, slackManifest } from "../../src/cli/manifest.ts"
import {
  ensureGitignore,
  readSecrets,
  SECRETS_FILE,
  writeSecrets,
} from "../../src/cli/secrets.ts"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stackping-cli-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
  delete process.env.SLACK_BOT_TOKEN
})

describe("Slack manifest", () => {
  it("points event subscriptions at the Worker", () => {
    const manifest = slackManifest("https://stackping-prod.acme.workers.dev/", {
      replies: true,
    })
    expect(manifest.settings.event_subscriptions?.request_url).toBe(
      "https://stackping-prod.acme.workers.dev/webhooks/slack",
    )
    expect(manifest.oauth_config.scopes.bot).toContain("chat:write.customize")
  })

  it("leaves out events when reply sync is off", () => {
    const manifest = slackManifest("https://x.workers.dev", { replies: false })
    expect(manifest.settings.event_subscriptions).toBeUndefined()
  })

  it("builds a create-app link with the manifest encoded", () => {
    const url = createAppUrl({ a: 1 })
    expect(url).toBe(
      `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent('{"a":1}')}`,
    )
  })
})

describe("secrets file", () => {
  it("round-trips with private permissions, and the environment wins", () => {
    const dir = tempDir()
    writeSecrets(dir, {
      SLACK_BOT_TOKEN: "xoxb-file",
      SLACK_SIGNING_SECRET: "abc",
    })
    expect(statSync(join(dir, SECRETS_FILE)).mode & 0o777).toBe(0o600)
    expect(readSecrets(dir)).toEqual({
      SLACK_BOT_TOKEN: "xoxb-file",
      SLACK_SIGNING_SECRET: "abc",
    })
    process.env.SLACK_BOT_TOKEN = "xoxb-env"
    expect(readSecrets(dir).SLACK_BOT_TOKEN).toBe("xoxb-env")
  })

  it("adds local files to .gitignore once", () => {
    const dir = tempDir()
    writeFileSync(join(dir, ".gitignore"), "node_modules")
    ensureGitignore(dir)
    ensureGitignore(dir)
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules\n.env.stackping\n.alchemy/\n",
    )
  })
})

describe("example config", () => {
  it("is valid", async () => {
    const { parseConfig } = await import("../../src/config.ts")
    const raw = JSON.parse(readFileSync("stackping.example.json", "utf8"))
    expect(parseConfig(raw).repos.map((repo) => repo.channel)).toEqual([
      "C0123ABCD",
      "C0456EFGH",
    ])
  })
})
