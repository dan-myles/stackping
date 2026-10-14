import { DurableObject } from "cloudflare:workers"

import type { StackpingConfig } from "../config.ts"
import type { SlackReplyEvent } from "../destinations/slack/inbound.ts"
import type { IngestResult } from "../engine/engine.ts"
import type { Sql, SqlValue } from "../engine/sql.ts"
import type { Env } from "./env.ts"

import { parseConfig } from "../config.ts"
import { SlackClient } from "../destinations/slack/client.ts"
import { SlackDestination } from "../destinations/slack/destination.ts"
import { Budget } from "../engine/budget.ts"
import { DEFAULT_SUBREQUEST_BUDGET, Engine } from "../engine/engine.ts"
import { cachedProfileLookup } from "../engine/profiles.ts"
import { Store } from "../engine/store.ts"
import { GitHubClient } from "../github/client.ts"

/**
 * The single Durable Object that owns all state. SQLite holds PRs, stacks,
 * and message IDs; one alarm drains the outbox.
 */
export class Hub extends DurableObject<Env> {
  readonly #engine: Engine
  #wakeAt: number | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const config: StackpingConfig = parseConfig(
      JSON.parse(env.STACKPING_CONFIG),
    )
    const sql = durableObjectSql(ctx)
    const budget = new Budget()
    const slack = new SlackClient({
      token: env.SLACK_BOT_TOKEN ?? "",
      fetch: budget.wrap((input, init) => fetch(input, init)),
      baseUrl: env.SLACK_API_URL,
    })
    const now = () => Date.now()
    const destination = new SlackDestination(
      slack,
      cachedProfileLookup(new Store(sql), slack, now),
    )
    const github = env.GITHUB_TOKEN
      ? new GitHubClient({
          token: env.GITHUB_TOKEN,
          fetch: budget.wrap((input, init) => fetch(input, init)),
          baseUrl: env.GITHUB_API_URL,
        })
      : null
    const subrequestBudget = Number(env.STACKPING_SUBREQUEST_BUDGET)
    this.#engine = new Engine({
      sql,
      config,
      destination,
      github,
      budget,
      now,
      wake: (at) => {
        this.#wakeAt = this.#wakeAt === null ? at : Math.min(this.#wakeAt, at)
      },
      subrequestBudget:
        Number.isFinite(subrequestBudget) && subrequestBudget > 0
          ? subrequestBudget
          : DEFAULT_SUBREQUEST_BUDGET,
    })
  }

  async ingestGitHub(input: {
    deliveryId: string
    event: string
    body: string
  }): Promise<IngestResult> {
    const result = this.#engine.ingestGitHub(input)
    await this.#armAlarm()
    return result
  }

  async ingestSlack(event: SlackReplyEvent): Promise<IngestResult> {
    const result = this.#engine.ingestSlack(event)
    await this.#armAlarm()
    return result
  }

  async cron(): Promise<void> {
    this.#engine.cron()
    await this.#armAlarm()
  }

  async status(): Promise<Record<string, unknown>> {
    return this.#engine.status()
  }

  override async alarm(): Promise<void> {
    // Cloudflare cleared the alarm that fired; tick re-arms the next one.
    this.#wakeAt = null
    await this.#engine.tick()
    await this.#armAlarm(true)
  }

  async #armAlarm(fired = false): Promise<void> {
    const at = this.#wakeAt
    this.#wakeAt = null
    if (at === null) return
    const current = fired ? null : await this.ctx.storage.getAlarm()
    if (current === null || at < current) {
      await this.ctx.storage.setAlarm(at)
    }
  }
}

function durableObjectSql(ctx: DurableObjectState): Sql {
  return {
    run(query: string, ...params: SqlValue[]) {
      ctx.storage.sql.exec(query, ...params)
    },
    all<T>(query: string, ...params: SqlValue[]): T[] {
      return ctx.storage.sql.exec(query, ...params).toArray() as T[]
    },
    transaction<T>(fn: () => T): T {
      return ctx.storage.transactionSync(fn)
    },
  }
}
