import { parseArgs } from "node:util"

import { ConfigError } from "../config.ts"
import { VERSION } from "../version.ts"
import * as commands from "./commands.ts"
import { failure } from "./prompt.ts"

const HELP = `stackping ${VERSION}: Slack notifications for Graphite stacks, self-hosted on Cloudflare

Usage: stackping <command> [--config stackping.json]

Commands:
  init       Set up stackping: repositories, Cloudflare, Slack app, first deploy
  deploy     Deploy (or update) the Worker with the current stackping.json
  status     Check the deployed Worker's health and recent delivery failures
  logs       Print recent Worker logs (--follow to stream)
  manifest   Print the Slack app manifest and its "Create app" link
  dev        Run the Worker locally with alchemy dev
  destroy    Remove the Worker, its storage, and the GitHub webhooks

Secrets come from the environment or .env.stackping:
  SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, STACKPING_GITHUB_TOKEN
Cloudflare: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or the login \`init\` opens.
GitHub webhooks are created with GITHUB_TOKEN or the GitHub CLI's login.`

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      follow: { type: "boolean", short: "f" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
  if (values.version) {
    console.log(VERSION)
    return 0
  }
  const [command] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return command || values.help ? 0 : 1
  }

  const context = { configPath: commands.resolveConfigPath(values.config) }
  try {
    switch (command) {
      case "init":
        return await commands.init(context)
      case "deploy":
        return await commands.deploy(context)
      case "destroy":
        return await commands.destroy(context)
      case "status":
        return await commands.status(context)
      case "logs":
        return await commands.logs(context, values.follow ?? false)
      case "manifest":
        return commands.manifest(context)
      case "dev":
        return await commands.dev(context)
      default:
        failure(`Unknown command: ${command}`)
        console.log(HELP)
        return 1
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      failure(error.message)
      return 1
    }
    if (error instanceof Error && error.message === "Cancelled") return 130
    throw error
  }
}
