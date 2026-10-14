import { fileURLToPath } from "node:url"

import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as GitHub from "alchemy/GitHub"
import * as Output from "alchemy/Output"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

import type { StackpingConfig } from "./config.ts"
import type { Hub } from "./worker/hub.ts"

import { GITHUB_WEBHOOK_EVENTS } from "./domain/github.ts"
import { VERSION } from "./version.ts"

export const COMPATIBILITY_DATE = "2026-08-31"

/** Reads an optional secret from the deploy environment; unset means unbound. */
const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")))

/**
 * The whole deployment: one Worker with one SQLite Durable Object and an
 * hourly cron, plus a signed GitHub webhook on every configured repository.
 */
export function stackping(config: StackpingConfig) {
  const local = process.env.STACKPING_STATE === "local"
  return Alchemy.Stack(
    "stackping",
    {
      providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
      state: local ? Alchemy.localState() : Cloudflare.state(),
    },
    Effect.gen(function* () {
      const dev = yield* Alchemy.ALCHEMY_DEV
      const webhookSecret = yield* Alchemy.Random("GitHubWebhookSecret")

      const worker = yield* Cloudflare.Worker("Stackping", {
        name: `stackping-${config.stage}`,
        main: fileURLToPath(new URL("./worker/index.ts", import.meta.url)),
        compatibility: { date: COMPATIBILITY_DATE },
        crons: ["0 * * * *"],
        env: {
          HUB: Cloudflare.DurableObject<Hub>("Hub", { className: "Hub" }),
          STACKPING_CONFIG: JSON.stringify(config),
          STACKPING_VERSION: VERSION,
          GITHUB_WEBHOOK_SECRET: webhookSecret.text,
          SLACK_BOT_TOKEN: optionalSecret("SLACK_BOT_TOKEN"),
          SLACK_SIGNING_SECRET: optionalSecret("SLACK_SIGNING_SECRET"),
          GITHUB_TOKEN: optionalSecret("STACKPING_GITHUB_TOKEN"),
          ...(process.env.STACKPING_SUBREQUEST_BUDGET
            ? {
                STACKPING_SUBREQUEST_BUDGET:
                  process.env.STACKPING_SUBREQUEST_BUDGET,
              }
            : {}),
          // Local testing only: point the Worker at fake Slack/GitHub APIs.
          ...(process.env.STACKPING_SLACK_API_URL
            ? { SLACK_API_URL: process.env.STACKPING_SLACK_API_URL }
            : {}),
          ...(process.env.STACKPING_GITHUB_API_URL
            ? { GITHUB_API_URL: process.env.STACKPING_GITHUB_API_URL }
            : {}),
        },
      })

      // `alchemy dev` serves on localhost, which GitHub cannot reach. Point
      // STACKPING_PUBLIC_URL at a tunnel to receive real webhooks in dev.
      const publicUrl = process.env.STACKPING_PUBLIC_URL
      if (!dev || publicUrl) {
        const base = publicUrl ? Output.literal(publicUrl) : worker.url
        for (const { repo } of config.repos) {
          const [owner, repository] = repo.split("/") as [string, string]
          yield* GitHub.Webhook(repo, {
            owner,
            repository,
            url: Output.interpolate`${base}/webhooks/github`,
            events: [...GITHUB_WEBHOOK_EVENTS],
            contentType: "json",
            // Resource props resolve Outputs at deploy time.
            secret: webhookSecret.text as unknown as Redacted.Redacted<string>,
          })
        }
      }

      return {
        url: worker.url.as<string>(),
        version: VERSION,
      }
    }),
  )
}
