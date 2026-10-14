import { Database } from "bun:sqlite"

import type { StackpingConfig } from "../src/config.ts"
import type { Sql, SqlValue } from "../src/engine/sql.ts"

import { parseConfig } from "../src/config.ts"
import { SlackClient } from "../src/destinations/slack/client.ts"
import { SlackDestination } from "../src/destinations/slack/destination.ts"
import { Budget } from "../src/engine/budget.ts"
import { Engine } from "../src/engine/engine.ts"
import { cachedProfileLookup } from "../src/engine/profiles.ts"
import { Store } from "../src/engine/store.ts"
import { GitHubClient } from "../src/github/client.ts"

export const REPO = { id: 1001, fullName: "acme/web", defaultBranch: "main" }
export const CHANNEL = "C0STACKPING"

export function bunSql(db = new Database(":memory:")): Sql {
  return {
    run: (query: string, ...params: SqlValue[]) => {
      db.query(query).run(...params)
    },
    all: <T>(query: string, ...params: SqlValue[]) =>
      db.query(query).all(...params) as T[],
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
  }
}

export interface SlackCall {
  readonly method: string
  readonly body: Record<string, unknown>
}

/** Records Slack Web API calls and answers like Slack would. */
export class FakeSlack {
  readonly calls: SlackCall[] = []
  readonly messages = new Map<
    string,
    { channel: string; text: string; threadTs?: string }
  >()
  #nextTs = 1_000
  #failures: Array<{
    method: string
    status: number
    error: string
    retryAfter?: number
  }> = []
  readonly profiles = new Map<
    string,
    { display_name: string; image_192: string }
  >()

  failNext(
    method: string,
    error: string,
    status = 200,
    retryAfter?: number,
  ): void {
    this.#failures.push({ method, error, status, retryAfter })
  }

  /** Drops a message, as if someone deleted it in Slack. */
  forget(ts: string): void {
    this.messages.delete(ts)
  }

  writes(): SlackCall[] {
    return this.calls.filter((call) => call.method.startsWith("chat."))
  }

  posts(): SlackCall[] {
    return this.calls.filter((call) => call.method === "chat.postMessage")
  }

  reset(): void {
    this.calls.length = 0
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = input.split("/").at(-1)!
    const raw = String(init?.body ?? "")
    const body = raw.startsWith("{")
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw))
    this.calls.push({ method, body })
    const failure = this.#failures.findIndex((entry) => entry.method === method)
    if (failure >= 0) {
      const [entry] = this.#failures.splice(failure, 1)
      return Response.json(
        { ok: false, error: entry!.error },
        {
          status: entry!.status,
          headers: entry!.retryAfter
            ? { "retry-after": String(entry!.retryAfter) }
            : {},
        },
      )
    }
    switch (method) {
      case "chat.postMessage": {
        const ts = `${(this.#nextTs += 1)}.000100`
        this.messages.set(ts, {
          channel: String(body.channel),
          text: String(body.text),
          threadTs: body.thread_ts ? String(body.thread_ts) : undefined,
        })
        return Response.json({ ok: true, ts, channel: body.channel })
      }
      case "chat.update": {
        const existing = this.messages.get(String(body.ts))
        if (!existing)
          return Response.json({ ok: false, error: "message_not_found" })
        existing.text = String(body.text)
        return Response.json({ ok: true, ts: body.ts })
      }
      case "chat.delete": {
        if (!this.messages.delete(String(body.ts))) {
          return Response.json({ ok: false, error: "message_not_found" })
        }
        return Response.json({ ok: true })
      }
      case "users.info": {
        const profile = this.profiles.get(String(body.user))
        if (!profile)
          return Response.json({ ok: false, error: "user_not_found" })
        return Response.json({ ok: true, user: { name: "x", profile } })
      }
      default:
        return Response.json({ ok: false, error: "unknown_method" })
    }
  }
}

export interface GitHubCall {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown> | null
}

export class FakeGitHub {
  readonly calls: GitHubCall[] = []
  graphql: unknown = { data: { repository: null } }
  #nextComment = 5_000

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname
    const method = init?.method ?? "GET"
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null
    this.calls.push({ method, path, body })
    if (path === "/graphql") return Response.json(this.graphql)
    if (method === "POST" && path.endsWith("/comments")) {
      const id = (this.#nextComment += 1)
      return Response.json(
        { id, html_url: `https://github.com/x/${id}` },
        { status: 201 },
      )
    }
    if (method === "PATCH") return Response.json({})
    if (method === "DELETE") return new Response(null, { status: 204 })
    return Response.json({ message: "Not Found" }, { status: 404 })
  }
}

export interface Harness {
  readonly engine: Engine
  readonly slack: FakeSlack
  readonly github: FakeGitHub
  readonly clock: { now: number }
  readonly wakes: number[]
  /** Sends a GitHub webhook through the engine. */
  deliver(
    event: string,
    payload: unknown,
    deliveryId?: string,
  ): ReturnType<Engine["ingestGitHub"]>
  /** Advances time and runs ticks until no work is due within `withinMs`. */
  settle(withinMs?: number): Promise<void>
  advance(ms: number): void
}

let deliveryCounter = 0

export function makeHarness(
  overrides: {
    config?: Partial<Record<string, unknown>>
    subrequestBudget?: number
    withGitHub?: boolean
  } = {},
): Harness {
  const config: StackpingConfig = parseConfig({
    slack: { channel: CHANNEL },
    repos: [{ repo: REPO.fullName }],
    users: { octocat: "U0OCTOCAT", hubot: "U0HUBOT00", monalisa: "U0MONALIS" },
    ...overrides.config,
  })
  const clock = { now: Date.parse("2026-10-14T12:00:00Z") }
  const slack = new FakeSlack()
  const github = new FakeGitHub()
  const sql = bunSql()
  const budget = new Budget()
  const slackClient = new SlackClient({
    token: "xoxb-test",
    fetch: budget.wrap(slack.fetch),
  })
  const destination = new SlackDestination(
    slackClient,
    cachedProfileLookup(new Store(sql), slackClient, () => clock.now),
  )
  const wakes: number[] = []
  const engine = new Engine({
    sql,
    config,
    destination,
    github:
      overrides.withGitHub === false
        ? null
        : new GitHubClient({
            token: "ghp_test",
            fetch: budget.wrap(github.fetch),
          }),
    budget,
    wake: (at) => wakes.push(at),
    now: () => clock.now,
    subrequestBudget: overrides.subrequestBudget,
    logger: { info() {}, warn() {}, error() {} },
  })

  return {
    engine,
    slack,
    github,
    clock,
    wakes,
    deliver: (event, payload, deliveryId) =>
      engine.ingestGitHub({
        event,
        deliveryId: deliveryId ?? `delivery-${(deliveryCounter += 1)}`,
        body: JSON.stringify(payload),
      }),
    advance: (ms) => {
      clock.now += ms
    },
    settle: async (withinMs = 60_000) => {
      const limit = clock.now + withinMs
      for (let guard = 0; guard < 500; guard += 1) {
        const next = engine.store.nextDueAt()
        if (next === null || next > limit) return
        if (next > clock.now) clock.now = next
        await engine.tick()
      }
      throw new Error("settle did not converge")
    },
  }
}

// GitHub payload builders

export interface PrSpec {
  number: number
  title?: string
  head: string
  base?: string
  action?: string
  draft?: boolean
  state?: "open" | "closed"
  merged?: boolean
  sha?: string
  author?: string
  reviewers?: string[]
  updatedAt?: number
  additions?: number
  requestedReviewer?: string
}

const USER_IDS: Record<string, number> = {
  octocat: 1,
  hubot: 2,
  monalisa: 3,
  "github-actions[bot]": 41898282,
  "graphite-app[bot]": 9999,
}

export function user(login: string) {
  return {
    id: USER_IDS[login] ?? 7_000 + login.length,
    login,
    avatar_url: `https://avatars.example/${login}.png`,
  }
}

export function prEvent(spec: PrSpec, clock: { now: number }) {
  return {
    action: spec.action ?? "opened",
    ...(spec.requestedReviewer
      ? { requested_reviewer: user(spec.requestedReviewer) }
      : {}),
    repository: {
      id: REPO.id,
      full_name: REPO.fullName,
      default_branch: REPO.defaultBranch,
    },
    sender: user(spec.author ?? "octocat"),
    pull_request: {
      number: spec.number,
      title: spec.title ?? `PR ${spec.number}`,
      html_url: `https://github.com/${REPO.fullName}/pull/${spec.number}`,
      state: spec.state ?? "open",
      draft: spec.draft ?? false,
      merged: spec.merged ?? false,
      updated_at: new Date(spec.updatedAt ?? clock.now).toISOString(),
      user: user(spec.author ?? "octocat"),
      requested_reviewers: (spec.reviewers ?? []).map(user),
      requested_teams: [],
      additions: spec.additions ?? 10,
      deletions: 2,
      changed_files: 1,
      commits: 1,
      head: {
        ref: spec.head,
        sha: spec.sha ?? `sha-${spec.number}`,
        repo: { id: REPO.id },
      },
      base: { ref: spec.base ?? "main", repo: { id: REPO.id } },
    },
  }
}

export function commentEvent(spec: {
  number: number
  id: number
  body: string
  author?: string
  action?: string
  updatedAt?: number
}) {
  const at = new Date(
    spec.updatedAt ?? Date.parse("2026-10-14T12:00:00Z"),
  ).toISOString()
  return {
    action: spec.action ?? "created",
    repository: { id: REPO.id, full_name: REPO.fullName },
    issue: { number: spec.number, pull_request: { url: "x" } },
    comment: {
      id: spec.id,
      body: spec.body,
      html_url: `https://github.com/${REPO.fullName}/pull/${spec.number}#issuecomment-${spec.id}`,
      user: user(spec.author ?? "hubot"),
      created_at: at,
      updated_at: at,
    },
  }
}

export function reviewEvent(spec: {
  number: number
  id: number
  state: string
  author?: string
  body?: string | null
  action?: string
  submittedAt: number
}) {
  return {
    action: spec.action ?? "submitted",
    repository: { id: REPO.id, full_name: REPO.fullName },
    pull_request: { number: spec.number },
    review: {
      id: spec.id,
      body: spec.body ?? null,
      html_url: `https://github.com/${REPO.fullName}/pull/${spec.number}#review-${spec.id}`,
      state: spec.state,
      user: user(spec.author ?? "hubot"),
      submitted_at: new Date(spec.submittedAt).toISOString(),
    },
  }
}

export function checkRunEvent(spec: {
  id: number
  name: string
  sha: string
  numbers: number[]
  conclusion: string | null
  status?: string
  at: number
}) {
  const at = new Date(spec.at).toISOString()
  return {
    action: "completed",
    repository: { id: REPO.id, full_name: REPO.fullName },
    check_run: {
      id: spec.id,
      name: spec.name,
      status: spec.status ?? "completed",
      conclusion: spec.conclusion,
      head_sha: spec.sha,
      html_url: `https://github.com/${REPO.fullName}/runs/${spec.id}`,
      details_url: null,
      started_at: at,
      completed_at: spec.conclusion ? at : null,
      pull_requests: spec.numbers.map((number) => ({ number })),
      output: { title: null, summary: null },
    },
  }
}
