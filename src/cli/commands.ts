import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import type { StackpingConfigFile } from "../config.ts"

import { ConfigError, parseConfig } from "../config.ts"
import { SlackClient } from "../destinations/slack/client.ts"
import { DeliveryError } from "../destinations/destination.ts"
import {
  hasCloudflareCredentials,
  runAlchemy,
  runAlchemyInteractive,
} from "./alchemy.ts"
import { createAppUrl, slackManifest } from "./manifest.ts"
import {
  ask,
  askSecret,
  confirm,
  failure,
  heading,
  note,
  style,
  success,
} from "./prompt.ts"
import {
  ensureGitignore,
  readSecrets,
  SECRETS_FILE,
  writeSecrets,
} from "./secrets.ts"

export interface CommandContext {
  /** Absolute path of stackping.json. */
  readonly configPath: string
}

type ConfigFileWithUrl = StackpingConfigFile & { url?: string }

function projectDir(context: CommandContext): string {
  return dirname(context.configPath)
}

function readConfigFile(context: CommandContext): ConfigFileWithUrl {
  if (!existsSync(context.configPath)) {
    throw new ConfigError(
      `No stackping.json at ${context.configPath}. Run \`stackping init\` first.`,
    )
  }
  const raw = JSON.parse(
    readFileSync(context.configPath, "utf8"),
  ) as ConfigFileWithUrl
  parseConfig(raw)
  return raw
}

function writeConfigFile(
  context: CommandContext,
  file: ConfigFileWithUrl,
): void {
  writeFileSync(context.configPath, `${JSON.stringify(file, null, 2)}\n`)
}

// deploy / destroy / dev / logs

export async function deploy(context: CommandContext): Promise<number> {
  const file = readConfigFile(context)
  const config = parseConfig(file)
  const secrets = readSecrets(projectDir(context))
  if (!secrets.SLACK_BOT_TOKEN) {
    note(
      `SLACK_BOT_TOKEN is not set (env or ${SECRETS_FILE}); Slack posts are disabled.`,
    )
  }
  heading(`Deploying stackping (${config.stage})`)
  const result = await runAlchemy(
    ["deploy", "--stage", config.stage, "--yes"],
    {
      cwd: projectDir(context),
      configPath: context.configPath,
      secrets,
      env: githubEnv(),
    },
  )
  if (result.code !== 0) return result.code
  if (result.url && result.url !== file.url) {
    writeConfigFile(context, { ...file, url: result.url })
  }
  if (result.url) success(`Live at ${style.bold(result.url)}`)
  return 0
}

export async function destroy(context: CommandContext): Promise<number> {
  const file = readConfigFile(context)
  const config = parseConfig(file)
  heading(`Destroying stackping (${config.stage})`)
  note(
    "Removes the Worker, its Durable Object storage, and the GitHub webhooks.",
  )
  if (process.stdin.isTTY && !(await confirm("Continue?", false))) return 1
  const result = await runAlchemy(
    ["destroy", "--stage", config.stage, "--yes"],
    {
      cwd: projectDir(context),
      configPath: context.configPath,
      secrets: readSecrets(projectDir(context)),
      env: githubEnv(),
    },
  )
  if (result.code === 0 && file.url) {
    const { url: _url, ...rest } = file
    writeConfigFile(context, rest)
  }
  return result.code
}

export async function dev(context: CommandContext): Promise<number> {
  const file = readConfigFile(context)
  heading("Running stackping locally")
  note(
    "State stays in .alchemy/; GitHub webhooks are only created with STACKPING_PUBLIC_URL.",
  )
  const result = await runAlchemy(["dev", "--stage", file.stage ?? "dev"], {
    cwd: projectDir(context),
    configPath: context.configPath,
    secrets: readSecrets(projectDir(context)),
    env: { STACKPING_STATE: "local" },
  })
  return result.code
}

export async function logs(
  context: CommandContext,
  follow: boolean,
): Promise<number> {
  const config = parseConfig(readConfigFile(context))
  const result = await runAlchemy(
    ["logs", "--stage", config.stage, ...(follow ? ["--tail"] : [])],
    { cwd: projectDir(context), configPath: context.configPath },
  )
  return result.code
}

// status / manifest

export async function status(context: CommandContext): Promise<number> {
  const file = readConfigFile(context)
  if (!file.url) {
    failure("No deployed URL recorded. Run `stackping deploy` first.")
    return 1
  }
  const response = await fetch(`${file.url}/health`).catch(() => null)
  if (!response?.ok) {
    failure(`${file.url} did not answer (${response?.status ?? "unreachable"})`)
    return 1
  }
  const health = (await response.json()) as Record<string, unknown>
  heading(`stackping ${health.version ?? ""} at ${file.url}`)
  const flag = (on: unknown, label: string) =>
    on ? success(label) : failure(`${label} (not configured)`)
  flag(health.slack, "Slack")
  flag(health.github, "GitHub token (hourly catch-up, Slack replies → GitHub)")
  note(`Pending deliveries: ${health.pending}   Failed: ${health.dead}`)
  if (typeof health.lastTickAt === "number") {
    note(`Last delivery run: ${new Date(health.lastTickAt).toISOString()}`)
  }
  const failures =
    (health.recentFailures as Array<{ key: string; error: string }>) ?? []
  for (const entry of failures) failure(`${entry.key}: ${entry.error}`)
  return 0
}

export function manifest(context: CommandContext): number {
  const file = readConfigFile(context)
  if (!file.url) {
    failure("Deploy first so the manifest can point at your Worker.")
    return 1
  }
  const value = slackManifest(file.url, { replies: file.replies ?? true })
  console.log(JSON.stringify(value, null, 2))
  console.log(`\nCreate the app: ${createAppUrl(value)}`)
  return 0
}

// init

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/
const CHANNEL_PATTERN = /^[CG][A-Z0-9]{6,}$/
const SLACK_USER_PATTERN = /^[UW][A-Z0-9]{6,}$/

export async function init(context: CommandContext): Promise<number> {
  const dir = projectDir(context)
  console.log(
    style.bold("\nstackping: Slack notifications for Graphite stacks\n"),
  )
  note(
    "This deploys one Worker and one Durable Object to your Cloudflare account,",
  )
  note("registers webhooks on your repositories, and connects a Slack app.")

  const existing = existsSync(context.configPath)
    ? (JSON.parse(
        readFileSync(context.configPath, "utf8"),
      ) as ConfigFileWithUrl)
    : null

  // 1. Repositories and channel
  heading("Repositories")
  const ghLogin = gh(["api", "user", "--jq", ".login"])
  if (ghLogin)
    note(`GitHub CLI signed in as ${ghLogin}; it is used to create webhooks.`)
  else
    note(
      "Tip: sign in with `gh auth login`, or set GITHUB_TOKEN with admin access to the repos.",
    )
  const repos = (
    await ask("Repositories to watch (owner/name, comma-separated):", {
      default: existing?.repos.map((entry) => entry.repo).join(", "),
      validate: (value) => {
        const list = splitList(value)
        if (list.length === 0) return "List at least one repository"
        const bad = list.find((repo) => !REPO_PATTERN.test(repo))
        return bad ? `${bad} is not owner/name` : null
      },
    })
  )
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean)

  heading("Slack channel")
  note(
    "Open the channel in Slack → channel name → About; the ID is at the bottom (C…).",
  )
  const channel = await ask("Channel ID:", {
    default: existing?.slack.channel,
    validate: (value) =>
      CHANNEL_PATTERN.test(value) ? null : "Expected an ID like C0123ABCD",
  })
  const stage = existing?.stage ?? "prod"

  let file: ConfigFileWithUrl = {
    ...existing,
    stage,
    slack: { channel },
    repos: repos.map(
      (repo) =>
        existing?.repos.find((entry) => entry.repo === repo) ?? { repo },
    ),
    users: existing?.users ?? {},
    links: existing?.links ?? "graphite",
    replies: existing?.replies ?? true,
  }
  writeConfigFile(context, file)
  ensureGitignore(dir)
  success(`Wrote ${context.configPath}`)

  // 2. Cloudflare
  heading("Cloudflare")
  if (hasCloudflareCredentials()) {
    success("Cloudflare credentials found")
  } else {
    note("A browser window opens to connect your Cloudflare account.")
    const code = await runAlchemyInteractive(
      ["profile", "edit", "--add", "Cloudflare"],
      {
        cwd: dir,
        configPath: context.configPath,
      },
    )
    if (code !== 0) {
      failure(
        "Cloudflare login failed. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, then rerun.",
      )
      return code
    }
  }

  // 3. First deploy, so Slack has a URL to verify
  const secrets = readSecrets(dir)
  if (!file.url || !secrets.SLACK_BOT_TOKEN) {
    heading("Deploying the Worker")
    const first = await runAlchemy(["deploy", "--stage", stage, "--yes"], {
      cwd: dir,
      configPath: context.configPath,
      secrets,
      env: githubEnv(),
    })
    if (first.code !== 0) return first.code
    if (!first.url) {
      failure("Deploy finished but no Worker URL was printed.")
      return 1
    }
    file = { ...file, url: first.url }
    writeConfigFile(context, file)
    success(`Worker is live at ${first.url}`)
  }

  // 4. Slack app
  heading("Slack app")
  if (secrets.SLACK_BOT_TOKEN && secrets.SLACK_SIGNING_SECRET) {
    success(`Using the Slack app credentials in ${SECRETS_FILE}`)
  } else {
    const link = createAppUrl(
      slackManifest(file.url!, { replies: file.replies ?? true }),
    )
    note(
      "Create the Slack app from stackping's manifest, then install it to your workspace:",
    )
    console.log(`\n  ${style.cyan(link)}\n`)
    openBrowser(link)
    note(
      "After installing: OAuth & Permissions → Bot User OAuth Token (xoxb-…),",
    )
    note("and Basic Information → Signing Secret.")
    secrets.SLACK_BOT_TOKEN = await askSecret("Bot token:", {
      validate: (value) =>
        value.startsWith("xoxb-") ? null : "Bot tokens start with xoxb-",
    })
    secrets.SLACK_SIGNING_SECRET = await askSecret("Signing secret:", {
      validate: (value) =>
        /^[0-9a-f]{32}$/i.test(value) ? null : "Expected 32 hex characters",
    })
  }
  const slack = new SlackClient({ token: secrets.SLACK_BOT_TOKEN! })
  try {
    const auth = await slack.authTest()
    success(`Connected to the ${style.bold(auth.team)} workspace`)
  } catch (error) {
    failure(
      `Slack rejected the bot token: ${error instanceof Error ? error.message : error}`,
    )
    return 1
  }

  // 5. Runtime GitHub token
  heading("GitHub token for the Worker")
  if (secrets.STACKPING_GITHUB_TOKEN) {
    success(`Using STACKPING_GITHUB_TOKEN from ${SECRETS_FILE}`)
  } else {
    note(
      "Optional. Powers the hourly catch-up for missed webhooks, and posts Slack",
    )
    note("thread replies as GitHub comments (authored by the token's owner).")
    note(
      "Create a fine-grained token for these repositories with Pull requests: read & write,",
    )
    note("Issues: read & write, Commit statuses / Checks / Deployments: read.")
    note("https://github.com/settings/personal-access-tokens/new")
    secrets.STACKPING_GITHUB_TOKEN = await askSecret("Token (Enter to skip):", {
      optional: true,
    })
    if (!secrets.STACKPING_GITHUB_TOKEN) {
      note(
        "Skipped: Slack replies stay in Slack and missed webhooks are not backfilled.",
      )
    }
  }

  // 6. People
  heading("People")
  note(
    "Map GitHub logins to Slack member IDs (Slack profile → ⋮ → Copy member ID)",
  )
  note("so reviewers get real @mentions. Enter a blank login to finish.")
  const users = { ...(file.users ?? {}) }
  if (ghLogin && !users[ghLogin]) {
    const id = await ask(`Slack member ID for ${ghLogin} (you):`, {
      validate: (value) =>
        !value || SLACK_USER_PATTERN.test(value)
          ? null
          : "Expected an ID like U0123ABCD",
    })
    if (id) users[ghLogin] = id
  }
  while (true) {
    const login = await ask("GitHub login:")
    if (!login) break
    const id = await ask(`Slack member ID for ${login}:`, {
      validate: (value) =>
        SLACK_USER_PATTERN.test(value) ? null : "Expected an ID like U0123ABCD",
    })
    users[login] = id
  }
  file = { ...file, users }
  writeConfigFile(context, file)
  writeSecrets(dir, secrets)
  success(`Saved secrets to ${SECRETS_FILE} (gitignored)`)

  // 7. Deploy with everything
  heading("Deploying with Slack connected")
  const second = await runAlchemy(["deploy", "--stage", stage, "--yes"], {
    cwd: dir,
    configPath: context.configPath,
    secrets,
    env: githubEnv(),
  })
  if (second.code !== 0) return second.code

  // 8. Say hello
  try {
    await slack.postMessage({
      channel,
      text: `:pancakes: stackping is connected. Pull requests from ${repos.map((repo) => `\`${repo}\``).join(", ")} will show up here.`,
    })
    success("Posted a hello message to the channel")
  } catch (error) {
    const code = error instanceof DeliveryError ? error.code : String(error)
    failure(`Could not post to ${channel}: ${code}`)
    if (code === "not_in_channel" || code === "channel_not_found") {
      note("For a private channel, invite the app first: /invite @stackping")
    }
  }

  heading("Done")
  note(`Open a pull request in ${repos[0]} to see it in Slack.`)
  note("Edit stackping.json and run `stackping deploy` to change settings;")
  note(
    "`stackping status` checks health, `stackping destroy` removes everything.",
  )
  return 0
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function gh(args: ReadonlyArray<string>): string | null {
  const result = spawnSync("gh", args, { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() || null : null
}

/**
 * Alchemy manages the repository webhooks with GITHUB_TOKEN; fall back to the
 * GitHub CLI's login so most people need no extra token.
 */
function githubEnv(): Record<string, string> {
  if (process.env.GITHUB_TOKEN || process.env.GITHUB_ACCESS_TOKEN) return {}
  const token = gh(["auth", "token"])
  return token ? { GITHUB_TOKEN: token } : {}
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open"
  spawnSync(command, [url], { stdio: "ignore" })
}

export function resolveConfigPath(flag: string | undefined): string {
  return resolve(flag ?? process.env.STACKPING_CONFIG_PATH ?? "stackping.json")
}
