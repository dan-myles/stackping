import type { StackpingConfig } from "../config.ts"
import type { Destination, Rendered } from "../destinations/destination.ts"
import type { SlackReplyEvent } from "../destinations/slack/inbound.ts"
import type {
  ActivityEvent,
  CheckInput,
  DeploymentInput,
  PullRequestEvent,
  PullRequestSnapshot,
  ThreadItemInput,
} from "../domain/github.ts"
import type {
  PullRequestView,
  StackView,
  ThreadItemView,
} from "../domain/view.ts"
import type { GitHubClient } from "../github/client.ts"
import type { Budget } from "./budget.ts"
import type { Sql } from "./sql.ts"
import type { ItemRecord, OutboxRecord, PullRequestRecord } from "./store.ts"

import { repoConfig } from "../config.ts"
import { DeliveryError } from "../destinations/destination.ts"
import { slackTextToGitHub } from "../destinations/slack/inbound.ts"
import {
  graphitePullRequestUrl,
  parseActivityEvent,
  parsePullRequestEvent,
  threadItemFromPullRequestEvent,
} from "../domain/github.ts"
import {
  classifyReviewNotification,
  reviewEvidence,
} from "../domain/reviewHistory.ts"
import {
  isIgnoredCheck,
  reviewStateFor,
  SLACK_ECHO_MARKER,
  stackRevisionKey,
  summarizeStackSignals,
  threadDeliveryMode,
} from "../domain/signals.ts"
import { isTrunkPromotion, trunkBranches } from "../domain/stacks.ts"
import { GitHubError } from "../github/client.ts"
import { BudgetExhausted } from "./budget.ts"
import { migrate } from "./schema.ts"
import { pullRequestId, Store } from "./store.ts"

/** Delay before rendering after a PR opens, so `gt submit --stack` lands as one message. */
export const STACK_SETTLE_MS = 2_000
const QUICK_SETTLE_MS = 250
const ITEM_WAIT_SETTLE_MS = 1_500
/** CI events arrive in bursts; batch the resulting re-renders. */
const CI_SETTLE_MS = 5_000
const MAX_ATTEMPTS = 8
const MAX_RETRY_MS = 30 * 60 * 1000
/** Jobs waiting on a root message give up after this long. */
const MAX_WAIT_MS = 10 * 60 * 1000
/** Reconcile only posts PRs it has never seen if they changed this recently. */
const RECONCILE_NEW_PR_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_REPLAY_ITEMS = 200
const TICK_WALL_TIME_MS = 25_000
export const DEFAULT_SUBREQUEST_BUDGET = 40

export type IngestResult =
  | { readonly status: "processed" }
  | { readonly status: "duplicate" }
  | { readonly status: "ignored"; readonly reason: string }

type JobOutcome =
  | { readonly type: "done" }
  | { readonly type: "wait"; readonly ms: number; readonly reason: string }
  | {
      readonly type: "retry"
      readonly error: string
      readonly retryAfterMs: number | null
    }
  | { readonly type: "dead"; readonly error: string }

interface ReplyPayload {
  readonly operation: SlackReplyEvent["operation"]
  readonly channel: string
  readonly ts: string
  readonly threadTs: string
  readonly slackUserId: string | null
  readonly text: string | null
  readonly eventTime: number
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export const consoleLogger: Logger = {
  info: (message, data) =>
    console.log(JSON.stringify({ level: "info", message, ...data })),
  warn: (message, data) =>
    console.warn(JSON.stringify({ level: "warn", message, ...data })),
  error: (message, data) =>
    console.error(JSON.stringify({ level: "error", message, ...data })),
}

export interface EngineOptions {
  readonly sql: Sql
  readonly config: StackpingConfig
  readonly destination: Destination
  readonly github: GitHubClient | null
  readonly budget: Budget
  /** Arms the wake-up (a Durable Object alarm) for the given time. */
  readonly wake: (at: number) => void
  readonly now?: () => number
  readonly subrequestBudget?: number
  readonly logger?: Logger
}

/**
 * Everything the Durable Object does: ingest webhooks into SQLite, and drain
 * a coalescing outbox of destination writes in budgeted ticks.
 */
export class Engine {
  readonly store: Store
  readonly #config: StackpingConfig
  readonly #destination: Destination
  readonly #github: GitHubClient | null
  readonly #budget: Budget
  readonly #wake: (at: number) => void
  readonly #now: () => number
  readonly #subrequestBudget: number
  readonly #log: Logger
  readonly #deployEnvironment: RegExp
  readonly #channelNextAt = new Map<string, number>()
  #ticking = false

  constructor(options: EngineOptions) {
    this.store = new Store(options.sql)
    this.#config = options.config
    this.#destination = options.destination
    this.#github = options.github
    this.#budget = options.budget
    this.#wake = options.wake
    this.#now = options.now ?? Date.now
    this.#subrequestBudget =
      options.subrequestBudget ?? DEFAULT_SUBREQUEST_BUDGET
    this.#log = options.logger ?? consoleLogger
    this.#deployEnvironment = new RegExp(options.config.deployEnvironment, "i")
    migrate(options.sql)
  }

  // Ingest

  ingestGitHub(input: {
    readonly deliveryId: string
    readonly event: string
    readonly body: string
  }): IngestResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(input.body)
    } catch {
      return { status: "ignored", reason: "invalid JSON" }
    }
    const repository = (parsed as { repository?: { full_name?: unknown } })
      ?.repository?.full_name
    if (
      typeof repository !== "string" ||
      !repoConfig(this.#config, repository)
    ) {
      return { status: "ignored", reason: "repository is not configured" }
    }

    const now = this.#now()
    const result = this.store.sql.transaction((): IngestResult => {
      if (
        input.deliveryId &&
        !this.store.claimDelivery(`github:${input.deliveryId}`, now)
      ) {
        return { status: "duplicate" }
      }
      if (input.event === "pull_request") {
        const event = parsePullRequestEvent(parsed)
        if (event === null) return { status: "ignored", reason: "unparseable" }
        return this.#ingestPullRequest(event, now)
      }
      const activity = parseActivityEvent(input.event, parsed)
      if (activity === null) {
        return { status: "ignored", reason: `unsupported ${input.event}` }
      }
      return this.#ingestActivity(activity, now)
    })
    this.#armWake()
    return result
  }

  ingestSlack(event: SlackReplyEvent): IngestResult {
    if (!this.#config.replies) {
      return { status: "ignored", reason: "reply sync is disabled" }
    }
    const now = this.#now()
    const result = this.store.sql.transaction((): IngestResult => {
      if (!this.store.claimDelivery(`slack:${event.eventId}`, now)) {
        return { status: "duplicate" }
      }
      const root = this.store.findRootMessageByTs(event.channel, event.threadTs)
      if (root === undefined) {
        return { status: "ignored", reason: "not a stackping thread" }
      }
      const key = `reply:${event.channel}:${event.ts}`
      const pending = this.store.getJob(key)
      if (pending?.payload) {
        const previous = JSON.parse(pending.payload) as ReplyPayload
        if (previous.eventTime > event.eventTime) {
          return { status: "ignored", reason: "older than pending event" }
        }
      }
      const payload: ReplyPayload = {
        operation: event.operation,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.threadTs,
        slackUserId: event.slackUserId,
        text: event.text,
        eventTime: event.eventTime,
      }
      this.store.enqueue(key, {
        channel: null,
        dueAt: now,
        payload: JSON.stringify(payload),
        now,
      })
      return { status: "processed" }
    })
    this.#armWake()
    return result
  }

  /** Hourly: reconcile every repository, and prune once a day. */
  cron(): void {
    const now = this.#now()
    this.store.sql.transaction(() => {
      if (this.#github !== null) {
        this.#config.repos.forEach((repo, index) => {
          this.store.enqueue(`reconcile:${repo.repo}`, {
            channel: null,
            dueAt: now + index * 1_000,
            now,
          })
        })
      }
    })
    const lastPrune = Number(this.store.getMeta("last_prune") ?? 0)
    if (now - lastPrune > 23 * 60 * 60 * 1000) {
      // Not wrapped in a transaction: prune opens one per pull request, and
      // Durable Objects do not nest transactionSync.
      this.store.prune(now)
      this.store.setMeta("last_prune", String(now))
    }
    this.#armWake()
  }

  status(): Record<string, unknown> {
    const counts = this.store.outboxCounts()
    return {
      pending: counts.pending,
      dead: counts.dead,
      lastTickAt: Number(this.store.getMeta("last_tick") ?? 0) || null,
      recentFailures: this.store.deadJobs(5),
    }
  }

  // Ticks

  /** Drains due jobs until the budget, the wall-time cap, or the queue runs out. */
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    this.#budget.reset(this.#subrequestBudget)
    const startedAt = this.#now()
    let exhausted = false
    try {
      outer: while (true) {
        const jobs = this.store.dueJobs(this.#now(), 25)
        if (jobs.length === 0) break
        let progressed = false
        for (const job of jobs) {
          if (this.#now() - startedAt > TICK_WALL_TIME_MS) break outer
          if (job.channel !== null) {
            const nextAt = this.#channelNextAt.get(job.channel) ?? 0
            if (nextAt > this.#now()) {
              this.store.rescheduleJob(job.key, job.rev, nextAt)
              continue
            }
          }
          progressed = true
          try {
            const outcome = await this.#run(job)
            this.#apply(job, outcome)
          } catch (error) {
            if (error instanceof BudgetExhausted) {
              exhausted = true
              break outer
            }
            this.#apply(job, {
              type: "retry",
              error: error instanceof Error ? error.message : String(error),
              retryAfterMs: null,
            })
          }
        }
        if (!progressed) break
      }
    } finally {
      this.#ticking = false
      this.#budget.unlimited()
      this.store.setMeta("last_tick", String(this.#now()))
      this.#armWake(exhausted ? this.#now() + 100 : undefined)
    }
  }

  #apply(job: OutboxRecord, outcome: JobOutcome): void {
    const now = this.#now()
    switch (outcome.type) {
      case "done":
        this.store.completeJob(job.key, job.rev)
        return
      case "wait":
        if (now - job.createdAt > MAX_WAIT_MS) {
          this.#log.warn("Dropping job that waited too long", {
            key: job.key,
            reason: outcome.reason,
          })
          this.store.completeJob(job.key, job.rev)
          return
        }
        this.store.rescheduleJob(job.key, job.rev, now + outcome.ms)
        return
      case "retry": {
        const attempts = job.attempts + 1
        if (attempts >= MAX_ATTEMPTS) {
          this.#log.error("Job failed permanently", {
            key: job.key,
            error: outcome.error,
          })
          this.store.killJob(job.key, job.rev, outcome.error)
          return
        }
        const backoff = Math.min(1_000 * 2 ** (attempts - 1), MAX_RETRY_MS)
        const delay = Math.min(
          Math.max(backoff, outcome.retryAfterMs ?? 0),
          MAX_RETRY_MS,
        )
        this.#log.warn("Job failed, retrying", {
          key: job.key,
          attempts,
          delay,
          error: outcome.error,
        })
        this.store.rescheduleJob(job.key, job.rev, now + delay, {
          attempts,
          error: outcome.error,
        })
        return
      }
      case "dead":
        this.#log.error("Job failed permanently", {
          key: job.key,
          error: outcome.error,
        })
        this.store.killJob(job.key, job.rev, outcome.error)
        return
    }
  }

  #armWake(at?: number): void {
    const next = this.store.nextDueAt()
    const target =
      at === undefined ? next : next === null ? at : Math.min(at, next)
    if (target !== null) this.#wake(Math.max(target, this.#now()))
  }

  async #run(job: OutboxRecord): Promise<JobOutcome> {
    const separator = job.key.indexOf(":")
    const kind = job.key.slice(0, separator)
    const ref = job.key.slice(separator + 1)
    try {
      switch (kind) {
        case "root":
          return await this.#syncRoot(ref)
        case "item":
          return await this.#syncItem(ref)
        case "ci":
          return await this.#syncCiSummary(ref)
        case "reply":
          return await this.#syncReply(job)
        case "reconcile":
          return await this.#reconcile(ref)
        default:
          return { type: "dead", error: `Unknown job ${job.key}` }
      }
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error
      if (error instanceof DeliveryError || error instanceof GitHubError) {
        return error.retryable
          ? {
              type: "retry",
              error: error.message,
              retryAfterMs: error.retryAfterMs,
            }
          : { type: "dead", error: error.message }
      }
      throw error
    }
  }

  // Pull request ingest

  #ingestPullRequest(event: PullRequestEvent, now: number): IngestResult {
    const applied = this.#applySnapshot(event.pullRequest, {
      source: "webhook",
      settleMs:
        event.action === "opened" ||
        event.action === "edited" ||
        event.action === "ready_for_review" ||
        event.action === "closed"
          ? STACK_SETTLE_MS
          : QUICK_SETTLE_MS,
      now,
    })
    if (applied === null) return { status: "ignored", reason: "stale" }
    const pr = applied

    if (event.action === "synchronize") {
      this.#enqueueCi(pr, now + CI_SETTLE_MS, now)
    }

    if (event.action === "review_request_removed") {
      const target = event.requestedReviewer
        ? { type: "user", id: event.requestedReviewer.id }
        : event.requestedTeam
          ? { type: "team", id: event.requestedTeam.id }
          : null
      if (target) {
        for (const item of this.store.reviewRequestItems(
          pr.id,
          target.type,
          target.id,
        )) {
          this.store.markItemDeleted(item.id)
          this.#enqueueItem(item.id, pr, now)
        }
      }
    }

    const item = threadItemFromPullRequestEvent(event)
    if (item !== null) this.#ingestItem(pr, item, now)
    return { status: "processed" }
  }

  /**
   * Stores a PR snapshot, re-links its stack, and schedules every root
   * message the change could affect. Returns null for stale snapshots.
   */
  #applySnapshot(
    snapshot: PullRequestSnapshot,
    options: {
      readonly source: "webhook" | "reconcile"
      readonly settleMs: number
      readonly now: number
    },
  ): PullRequestRecord | null {
    const id = pullRequestId(snapshot.repositoryId, snapshot.number)
    const existing = this.store.getPullRequest(id)
    if (existing && existing.githubUpdatedAt > snapshot.githubUpdatedAt) {
      return null
    }
    if (options.source === "reconcile") {
      if (existing && existing.githubUpdatedAt === snapshot.githubUpdatedAt) {
        return existing
      }
      if (
        !existing &&
        (snapshot.status === "closed" ||
          snapshot.status === "merged" ||
          options.now - snapshot.githubUpdatedAt > RECONCILE_NEW_PR_WINDOW_MS)
      ) {
        return null
      }
    }

    this.store.upsertPullRequest(snapshot, options.now)
    const pr = this.store.getPullRequest(id)!
    const touched = new Set<string>([pr.id])

    const previousParentId = pr.parentId
    const parentId = this.#computeParent(pr)
    if (parentId !== previousParentId) {
      this.store.setParent(pr.id, parentId)
      if (previousParentId) touched.add(previousParentId)
    }

    // Adopt PRs stacked on this one, e.g. when a child was opened first.
    for (const child of this.store.findOpenByBase(
      pr.headRepositoryId,
      pr.headRef,
    )) {
      if (child.id === pr.id) continue
      const childParent = this.#computeParent(child)
      if (childParent !== child.parentId) {
        this.store.setParent(child.id, childParent)
        touched.add(child.id)
        if (child.parentId) touched.add(child.parentId)
      }
    }

    const dueAt = options.now + options.settleMs
    for (const touchedId of touched) {
      const record = this.store.getPullRequest(touchedId)
      if (!record) continue
      // Each root job settles its own message: re-renders a root, or folds
      // a former root's message into the stack that now contains it.
      this.#enqueueRoot(record, dueAt, options.now)
      const root = this.store.findRoot(record)
      if (root.id !== record.id) this.#enqueueRoot(root, dueAt, options.now)
    }
    return this.store.getPullRequest(id)!
  }

  #computeParent(pr: PullRequestRecord): string | null {
    const trunks = repoConfig(this.#config, pr.repositoryFullName)?.trunks ?? []
    if (isTrunkPromotion(pr, trunks)) return null
    if (
      pr.baseRepositoryId === pr.repositoryId &&
      trunkBranches(pr.defaultBranch, trunks).has(pr.baseRef)
    ) {
      return null
    }
    const candidates = this.store
      .findByHead(pr.baseRepositoryId, pr.baseRef)
      .filter(
        (candidate) =>
          candidate.id !== pr.id &&
          candidate.repositoryId === pr.repositoryId &&
          !isTrunkPromotion(candidate, trunks) &&
          !this.#descendsFrom(candidate, pr.id),
      )
      .sort((left, right) => {
        const leftOpen = left.status === "open" || left.status === "draft"
        const rightOpen = right.status === "open" || right.status === "draft"
        if (leftOpen !== rightOpen) return leftOpen ? -1 : 1
        return right.number - left.number
      })
    return candidates[0]?.id ?? null
  }

  #descendsFrom(pr: PullRequestRecord, ancestorId: string): boolean {
    let current: PullRequestRecord | undefined = pr
    for (let depth = 0; current && depth < 30; depth += 1) {
      if (current.parentId === ancestorId) return true
      current = current.parentId
        ? this.store.getPullRequest(current.parentId)
        : undefined
    }
    return false
  }

  // Activity ingest

  #ingestActivity(activity: ActivityEvent, now: number): IngestResult {
    switch (activity.activity.type) {
      case "thread": {
        const number = activity.pullRequestNumbers[0]
        const pr =
          number === undefined
            ? undefined
            : this.store.findByNumber(activity.repositoryId, number)
        if (!pr) return { status: "ignored", reason: "unknown pull request" }
        this.#ingestItem(pr, activity.activity.item, now)
        return { status: "processed" }
      }
      case "check":
        return this.#ingestCheck(activity, activity.activity.check, now)
      case "deployment":
        return this.#ingestDeployment(
          activity,
          activity.activity.deployment,
          now,
        )
    }
  }

  #ingestItem(
    pr: PullRequestRecord,
    input: ThreadItemInput,
    now: number,
  ): void {
    const result = this.store.upsertItem(pr.id, input, now)
    if (result === null) return
    const { item, created } = result

    if (created) {
      const evidence = reviewEvidence(item)
      if (evidence !== null) {
        const kind = classifyReviewNotification(
          evidence,
          item.occurredAt,
          this.store.reviewHistory(pr.id),
        )
        this.store.setReviewKind(item.id, kind)
        this.store.recordReviewHistory({
          itemId: item.id,
          prId: pr.id,
          ...evidence,
          occurredAt: item.occurredAt,
        })
      }
    }

    if (
      created &&
      item.kind === "pull_request" &&
      item.action === "review_requested" &&
      item.state === "user" &&
      item.targetId !== null
    ) {
      // Asked again: their earlier verdict no longer stands.
      this.store.clearReview(pr.id, item.targetId)
    }

    if (item.kind === "review" && item.actorId !== null && item.actorLogin) {
      const state = reviewStateFor(item.state)
      if (state !== null) {
        this.store.upsertReview(pr.id, {
          reviewerId: item.actorId,
          login: item.actorLogin,
          state,
          updatedAt: item.sourceUpdatedAt,
        })
      }
    }

    const mode = threadDeliveryMode(item)
    if (mode !== "ignore" || this.store.getMessage(`item:${item.id}`)) {
      this.#enqueueItem(item.id, pr, now)
    }
    if (mode === "thread_and_root") {
      this.#enqueueRoot(this.store.findRoot(pr), now + QUICK_SETTLE_MS, now)
    }
  }

  #ingestCheck(
    activity: ActivityEvent,
    check: CheckInput,
    now: number,
  ): IngestResult {
    const prs = this.#matchPullRequests(activity, check.headSha)
    if (prs.length === 0) return { status: "ignored", reason: "no matching PR" }
    const normalized = isIgnoredCheck(check)
      ? { ...check, state: "skipped" }
      : check
    for (const pr of prs) {
      const changed = this.store.upsertCheck(pr.id, normalized, pr.headSha)
      if (!changed || check.headSha !== pr.headSha) continue
      this.#enqueueRoot(this.store.findRoot(pr), now + CI_SETTLE_MS, now)
      this.#enqueueCi(pr, now + CI_SETTLE_MS, now)
    }
    return { status: "processed" }
  }

  #ingestDeployment(
    activity: ActivityEvent,
    deployment: DeploymentInput,
    now: number,
  ): IngestResult {
    if (!this.#deployEnvironment.test(deployment.environment)) {
      return { status: "ignored", reason: "not a tracked environment" }
    }
    const prs = this.#matchPullRequests(activity, deployment.headSha)
    if (prs.length === 0) return { status: "ignored", reason: "no matching PR" }
    for (const pr of prs) {
      this.store.upsertDeployment(pr.id, deployment)
      this.#enqueueRoot(this.store.findRoot(pr), now + QUICK_SETTLE_MS, now)
    }
    return { status: "processed" }
  }

  #matchPullRequests(
    activity: ActivityEvent,
    headSha: string,
  ): PullRequestRecord[] {
    const byNumber = activity.pullRequestNumbers
      .map((number) => this.store.findByNumber(activity.repositoryId, number))
      .filter((pr): pr is PullRequestRecord => pr !== undefined)
    return byNumber.length > 0
      ? byNumber
      : this.store.findByHeadSha(activity.repositoryId, headSha)
  }

  // Enqueue helpers

  #channelFor(
    pr: Pick<PullRequestRecord, "repositoryFullName">,
  ): string | null {
    return repoConfig(this.#config, pr.repositoryFullName)?.channel ?? null
  }

  #enqueueRoot(pr: PullRequestRecord, dueAt: number, now: number): void {
    const channel = this.#channelFor(pr)
    if (channel === null) return
    this.store.enqueue(`root:${pr.id}`, { channel, dueAt, now })
  }

  #enqueueItem(itemId: string, pr: PullRequestRecord, now: number): void {
    const channel = this.#channelFor(pr)
    if (channel === null) return
    const root = this.store.findRoot(pr)
    const posted = this.store.getMessage(`root:${root.id}`) !== undefined
    this.store.enqueue(`item:${itemId}`, {
      channel,
      dueAt: now + (posted ? QUICK_SETTLE_MS : ITEM_WAIT_SETTLE_MS),
      now,
    })
  }

  #enqueueCi(pr: PullRequestRecord, dueAt: number, now: number): void {
    const channel = this.#channelFor(pr)
    if (channel === null) return
    const root = this.store.findRoot(pr)
    this.store.enqueue(`ci:${root.id}`, { channel, dueAt, now })
  }

  // Delivery jobs

  async #syncRoot(prId: string): Promise<JobOutcome> {
    const pr = this.store.getPullRequest(prId)
    if (!pr) return { type: "done" }
    const root = this.store.findRoot(pr)
    const now = this.#now()

    if (root.id !== pr.id) {
      // This PR joined another stack; its old message must not linger.
      const own = this.store.getMessage(`root:${pr.id}`)
      if (own) await this.#foldMessage(pr, root, own.key)
      this.#enqueueRoot(root, now, now)
      return { type: "done" }
    }

    const channel = this.#channelFor(root)
    if (channel === null) return { type: "done" }

    let existing = this.store.getMessage(`root:${root.id}`)
    if (!existing) existing = this.#inheritMessage(root)
    if (!existing && root.status !== "open") {
      // Drafts post when they become ready; closed PRs never post.
      return { type: "done" }
    }

    const rendered = await this.#destination.renderStack(this.#stackView(root))
    if (existing && existing.renderKey === rendered.key) return { type: "done" }

    if (existing) {
      try {
        await this.#write(existing.channel, () =>
          this.#destination.update(existing!, rendered),
        )
        this.store.saveMessage({ ...existing, renderKey: rendered.key }, now)
        return { type: "done" }
      } catch (error) {
        if (!(error instanceof DeliveryError && error.notFound)) throw error
        this.#log.warn("Root message disappeared; reposting", { pr: root.id })
        this.store.deleteMessage(existing.key)
        await this.#postRoot(root, channel, rendered)
        this.#replayThread(root, existing.channel, existing.ts)
        return { type: "done" }
      }
    }

    await this.#postRoot(root, channel, rendered)
    return { type: "done" }
  }

  async #postRoot(
    root: PullRequestRecord,
    channel: string,
    rendered: Rendered,
  ): Promise<void> {
    const ref = await this.#write(channel, () =>
      this.#destination.post({ channel }, rendered),
    )
    this.store.saveMessage(
      {
        key: `root:${root.id}`,
        prId: root.id,
        channel: ref.channel,
        ts: ref.ts,
        threadTs: null,
        renderKey: rendered.key,
      },
      this.#now(),
    )
  }

  /**
   * When a stack's bottom PR merges and the next PR is retargeted to trunk,
   * the next PR inherits the stack's message instead of posting a new one.
   */
  #inheritMessage(root: PullRequestRecord) {
    if (!root.previousParentId) return undefined
    const previous = this.store.getPullRequest(root.previousParentId)
    if (
      !previous ||
      (previous.status !== "merged" && previous.status !== "closed")
    ) {
      return undefined
    }
    const message = this.store.getMessage(`root:${previous.id}`)
    if (!message) return undefined
    this.store.renameMessage(message.key, `root:${root.id}`, root.id)
    return this.store.getMessage(`root:${root.id}`)
  }

  /** Removes a former root's message, or points it at its new stack. */
  async #foldMessage(
    pr: PullRequestRecord,
    root: PullRequestRecord,
    key: string,
  ): Promise<void> {
    const message = this.store.getMessage(key)!
    const hasThread =
      this.store.hasHumanReplies(pr.id) ||
      this.store.repliesInThread(message.channel, message.ts).length > 0
    if (hasThread) {
      const rendered = await this.#destination.renderMoved(
        this.#pullRequestView(pr),
        this.#pullRequestView(root),
      )
      try {
        await this.#write(message.channel, () =>
          this.#destination.update(message, rendered),
        )
      } catch (error) {
        if (!(error instanceof DeliveryError && error.notFound)) throw error
      }
      this.store.renameMessage(key, `moved:${pr.id}`, pr.id)
      return
    }
    await this.#write(message.channel, () => this.#destination.remove(message))
    this.store.deleteMessage(key)
  }

  /** After a root message is reposted, re-post what lived in its thread. */
  #replayThread(root: PullRequestRecord, channel: string, oldTs: string): void {
    const now = this.#now()
    for (const reply of this.store.repliesInThread(channel, oldTs)) {
      this.store.deleteMessage(reply.key)
    }
    const members = this.store.stackMembers(root)
    for (const item of this.store.itemsFor(
      members.map((member) => member.id),
      MAX_REPLAY_ITEMS,
    )) {
      if (item.deleted || threadDeliveryMode(item) === "ignore") continue
      const pr = members.find((member) => member.id === item.prId) ?? root
      this.#enqueueItem(item.id, pr, now)
    }
    this.#enqueueCi(root, now, now)
  }

  async #syncItem(itemId: string): Promise<JobOutcome> {
    const item = this.store.getItem(itemId)
    if (!item) return { type: "done" }
    const pr = this.store.getPullRequest(item.prId)
    if (!pr) return { type: "done" }
    const key = `item:${item.id}`
    const existing = this.store.getMessage(key)
    const retracted =
      item.deleted &&
      item.kind === "pull_request" &&
      item.action === "review_requested"

    if (threadDeliveryMode(item) === "ignore" || retracted) {
      if (existing) {
        await this.#write(existing.channel, () =>
          this.#destination.remove(existing),
        )
        this.store.deleteMessage(key)
      }
      return { type: "done" }
    }

    const rendered = await this.#destination.renderThreadItem(
      this.#itemView(item, pr),
    )
    const now = this.#now()
    if (existing) {
      if (existing.renderKey === rendered.key) return { type: "done" }
      try {
        await this.#write(existing.channel, () =>
          this.#destination.update(existing, rendered),
        )
        this.store.saveMessage({ ...existing, renderKey: rendered.key }, now)
        return { type: "done" }
      } catch (error) {
        if (!(error instanceof DeliveryError && error.notFound)) throw error
        this.store.deleteMessage(key)
      }
    }
    if (item.deleted) return { type: "done" }

    const root = this.store.findRoot(pr)
    const rootMessage = this.store.getMessage(`root:${root.id}`)
    if (!rootMessage) {
      if (root.status !== "open") return { type: "done" }
      return { type: "wait", ms: 2_000, reason: "root message not posted yet" }
    }
    const ref = await this.#write(rootMessage.channel, () =>
      this.#destination.post(
        { channel: rootMessage.channel, threadTs: rootMessage.ts },
        rendered,
      ),
    )
    this.store.saveMessage(
      {
        key,
        prId: pr.id,
        channel: ref.channel,
        ts: ref.ts,
        threadTs: rootMessage.ts,
        renderKey: rendered.key,
      },
      now,
    )
    return { type: "done" }
  }

  async #syncCiSummary(prId: string): Promise<JobOutcome> {
    const pr = this.store.getPullRequest(prId)
    if (!pr) return { type: "done" }
    const root = this.store.findRoot(pr)
    const members = this.store.stackMembers(root)
    const signals = this.#signals(members)
    const key = `ci:${root.id}:${stackRevisionKey(members)}`
    const existing = this.store.getMessage(key)
    if (signals.build.failing === 0 && !existing) return { type: "done" }

    const rootMessage = this.store.getMessage(`root:${root.id}`)
    if (!rootMessage) {
      if (root.status !== "open") return { type: "done" }
      return { type: "wait", ms: 2_000, reason: "root message not posted yet" }
    }
    const rendered = await this.#destination.renderCiSummary({
      root: this.#pullRequestView(root),
      build: signals.build,
    })
    const now = this.#now()
    if (existing) {
      if (existing.renderKey === rendered.key) return { type: "done" }
      try {
        await this.#write(existing.channel, () =>
          this.#destination.update(existing, rendered),
        )
        this.store.saveMessage({ ...existing, renderKey: rendered.key }, now)
        return { type: "done" }
      } catch (error) {
        if (!(error instanceof DeliveryError && error.notFound)) throw error
        this.store.deleteMessage(key)
      }
    }
    const ref = await this.#write(rootMessage.channel, () =>
      this.#destination.post(
        { channel: rootMessage.channel, threadTs: rootMessage.ts },
        rendered,
      ),
    )
    this.store.saveMessage(
      {
        key,
        prId: root.id,
        channel: ref.channel,
        ts: ref.ts,
        threadTs: rootMessage.ts,
        renderKey: rendered.key,
      },
      now,
    )
    return { type: "done" }
  }

  async #syncReply(job: OutboxRecord): Promise<JobOutcome> {
    if (this.#github === null) {
      return {
        type: "dead",
        error: "No GitHub token configured for reply sync",
      }
    }
    if (!job.payload) return { type: "done" }
    const reply = JSON.parse(job.payload) as ReplyPayload
    const rootMessage = this.store.findRootMessageByTs(
      reply.channel,
      reply.threadTs,
    )
    if (!rootMessage) return { type: "done" }
    const pr = this.store.getPullRequest(rootMessage.prId)
    if (!pr) return { type: "done" }

    const slackKey = `${reply.channel}:${reply.ts}`
    const link = this.store.getReplyLink(slackKey)
    if (link && link.lastEventTime >= reply.eventTime) return { type: "done" }

    if (reply.operation === "delete") {
      if (link) {
        try {
          await this.#github.deleteIssueComment(
            pr.repositoryFullName,
            link.commentId,
          )
        } catch (error) {
          if (!(error instanceof GitHubError && error.notFound)) throw error
        }
        this.store.deleteReplyLink(slackKey)
      }
      return { type: "done" }
    }

    const body = this.#replyBody(reply)
    if (link) {
      try {
        await this.#github.updateIssueComment(
          pr.repositoryFullName,
          link.commentId,
          body,
        )
        this.store.saveReplyLink(slackKey, {
          ...link,
          lastEventTime: reply.eventTime,
        })
        return { type: "done" }
      } catch (error) {
        if (!(error instanceof GitHubError && error.notFound)) throw error
      }
    }
    const comment = await this.#github.createIssueComment(
      pr.repositoryFullName,
      pr.number,
      body,
    )
    this.store.saveReplyLink(slackKey, {
      prId: pr.id,
      commentId: comment.id,
      lastEventTime: reply.eventTime,
    })
    return { type: "done" }
  }

  #replyBody(reply: ReplyPayload): string {
    const loginForSlackUser = (slackUserId: string) =>
      Object.entries(this.#config.users).find(
        ([, id]) => id === slackUserId,
      )?.[0] ?? null
    const author = reply.slackUserId
      ? loginForSlackUser(reply.slackUserId)
      : null
    const profile = reply.slackUserId
      ? this.store.getProfile(reply.slackUserId)
      : undefined
    const name = author ?? profile?.name ?? "Someone"
    const text = slackTextToGitHub(reply.text ?? "", loginForSlackUser).trim()
    return [
      `**${name}** replied in Slack:`,
      "",
      text,
      "",
      `${SLACK_ECHO_MARKER}${reply.channel}:${reply.ts} -->`,
    ].join("\n")
  }

  async #reconcile(repo: string): Promise<JobOutcome> {
    if (this.#github === null) return { type: "done" }
    const result = await this.#github.reconcileRepository(repo)
    const now = this.#now()
    this.store.sql.transaction(() => {
      for (const reconciled of result.pullRequests) {
        const before = this.store.getPullRequest(
          pullRequestId(
            reconciled.snapshot.repositoryId,
            reconciled.snapshot.number,
          ),
        )
        const pr = this.#applySnapshot(reconciled.snapshot, {
          source: "reconcile",
          settleMs: QUICK_SETTLE_MS,
          now,
        })
        if (pr === null) continue
        let changed = before?.githubUpdatedAt !== pr.githubUpdatedAt
        for (const check of reconciled.checks) {
          const normalized = isIgnoredCheck(check)
            ? { ...check, state: "skipped" }
            : check
          if (this.store.upsertCheck(pr.id, normalized, pr.headSha))
            changed = true
        }
        for (const review of reconciled.reviews) {
          this.store.upsertReview(pr.id, review)
        }
        if (changed) {
          this.#enqueueRoot(this.store.findRoot(pr), now + QUICK_SETTLE_MS, now)
          this.#enqueueCi(pr, now + QUICK_SETTLE_MS, now)
        }
      }
    })
    return { type: "done" }
  }

  /** Runs a destination write, then reserves the channel's next slot. */
  async #write<T>(channel: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } finally {
      this.#channelNextAt.set(
        channel,
        this.#now() + this.#destination.spacingMs,
      )
    }
  }

  // Views

  #pullRequestView(pr: PullRequestRecord): PullRequestView {
    return {
      id: pr.id,
      parentId: pr.parentId,
      repositoryFullName: pr.repositoryFullName,
      number: pr.number,
      title: pr.title,
      url:
        this.#config.links === "graphite"
          ? graphitePullRequestUrl(pr.repositoryFullName, pr.number)
          : pr.url,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      status: pr.status,
      authorId: pr.authorId,
      authorLogin: pr.authorLogin,
      authorAvatarUrl: pr.authorAvatarUrl,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      commitCount: pr.commitCount,
    }
  }

  #signals(members: ReadonlyArray<PullRequestRecord>) {
    const ids = members.map((member) => member.id)
    return summarizeStackSignals({
      pullRequests: members,
      checks: this.store.checksFor(ids),
      reviews: this.store.reviewsFor(ids),
      deployments: this.store.deploymentsFor(ids),
    })
  }

  #stackView(root: PullRequestRecord): StackView {
    const members = this.store.stackMembers(root)
    return {
      root: this.#pullRequestView(root),
      members: members.map((member) => this.#pullRequestView(member)),
      signals: this.#signals(members),
      users: this.#config.users,
    }
  }

  #itemView(item: ItemRecord, pr: PullRequestRecord): ThreadItemView {
    return {
      kind: item.kind,
      action: item.action,
      actorLogin: item.actorLogin,
      actorAvatarUrl: item.actorAvatarUrl,
      body: item.body,
      url: item.url,
      state: item.state,
      path: item.path,
      line: item.line,
      targetName: item.targetName,
      targetId: item.targetId,
      deleted: item.deleted,
      edited: item.edited,
      reviewNotificationKind: item.reviewKind,
      pullRequest: {
        number: pr.number,
        url: this.#pullRequestView(pr).url,
        authorLogin: pr.authorLogin,
        reviewers: pr.reviewers,
        reviewerTeams: pr.reviewerTeams,
      },
      users: this.#config.users,
    }
  }
}
