import type {
  CheckInput,
  GitHubTeam,
  GitHubUser,
  PullRequestSnapshot,
  PullRequestStatus,
  ThreadItemInput,
  ThreadItemKind,
} from "../domain/github.ts"
import type { ReviewNotificationKind } from "../domain/reviewHistory.ts"
import type {
  CheckRow,
  DeploymentRow,
  ReviewRow,
  ReviewState,
} from "../domain/signals.ts"
import type { Sql, SqlValue } from "./sql.ts"

import { MAX_PULL_REQUESTS_PER_STACK } from "../domain/stacks.ts"
import { one } from "./sql.ts"

export interface PullRequestRecord {
  readonly id: string
  readonly repositoryId: number
  readonly repositoryFullName: string
  readonly number: number
  readonly title: string
  readonly url: string
  readonly authorId: number
  readonly authorLogin: string
  readonly authorAvatarUrl: string | null
  readonly status: PullRequestStatus
  readonly headRepositoryId: number
  readonly headRef: string
  readonly headSha: string | null
  readonly baseRepositoryId: number
  readonly baseRef: string
  readonly defaultBranch: string | null
  readonly parentId: string | null
  readonly previousParentId: string | null
  readonly reviewers: ReadonlyArray<GitHubUser>
  readonly reviewerTeams: ReadonlyArray<GitHubTeam>
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly commitCount: number
  readonly githubUpdatedAt: number
}

export interface ItemRecord {
  readonly id: string
  readonly prId: string
  readonly kind: ThreadItemKind
  readonly action: string
  readonly actorId: number | null
  readonly actorLogin: string | null
  readonly actorAvatarUrl: string | null
  readonly body: string | null
  readonly url: string | null
  readonly state: string | null
  readonly path: string | null
  readonly line: number | null
  readonly targetName: string | null
  readonly targetId: number | null
  readonly deleted: boolean
  readonly edited: boolean
  readonly reviewKind: ReviewNotificationKind | null
  readonly occurredAt: number
  readonly sourceUpdatedAt: number
}

export interface MessageRecord {
  readonly key: string
  readonly prId: string
  readonly channel: string
  readonly ts: string
  readonly threadTs: string | null
  readonly renderKey: string
}

export interface OutboxRecord {
  readonly key: string
  readonly channel: string | null
  readonly payload: string | null
  readonly dueAt: number
  readonly rev: number
  readonly attempts: number
  readonly createdAt: number
}

export function pullRequestId(repositoryId: number, number: number): string {
  return `${repositoryId}:${number}`
}

type PrRow = {
  id: string
  repo_id: number
  repo: string
  number: number
  title: string
  url: string
  author_id: number
  author_login: string
  author_avatar: string | null
  status: PullRequestStatus
  head_repo_id: number
  head_ref: string
  head_sha: string | null
  base_repo_id: number
  base_ref: string
  default_branch: string | null
  parent_id: string | null
  previous_parent_id: string | null
  reviewers: string
  reviewer_teams: string
  additions: number
  deletions: number
  changed_files: number
  commit_count: number
  github_updated_at: number
}

function toPullRequest(row: PrRow): PullRequestRecord {
  return {
    id: row.id,
    repositoryId: row.repo_id,
    repositoryFullName: row.repo,
    number: row.number,
    title: row.title,
    url: row.url,
    authorId: row.author_id,
    authorLogin: row.author_login,
    authorAvatarUrl: row.author_avatar,
    status: row.status,
    headRepositoryId: row.head_repo_id,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRepositoryId: row.base_repo_id,
    baseRef: row.base_ref,
    defaultBranch: row.default_branch,
    parentId: row.parent_id,
    previousParentId: row.previous_parent_id,
    reviewers: JSON.parse(row.reviewers) as GitHubUser[],
    reviewerTeams: JSON.parse(row.reviewer_teams) as GitHubTeam[],
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changed_files,
    commitCount: row.commit_count,
    githubUpdatedAt: row.github_updated_at,
  }
}

type ItemRow = {
  id: string
  pr_id: string
  kind: ThreadItemKind
  action: string
  actor_id: number | null
  actor_login: string | null
  actor_avatar: string | null
  body: string | null
  url: string | null
  state: string | null
  path: string | null
  line: number | null
  target_name: string | null
  target_id: number | null
  deleted: number
  edited: number
  review_kind: ReviewNotificationKind | null
  occurred_at: number
  source_updated_at: number
}

function toItem(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    prId: row.pr_id,
    kind: row.kind,
    action: row.action,
    actorId: row.actor_id,
    actorLogin: row.actor_login,
    actorAvatarUrl: row.actor_avatar,
    body: row.body,
    url: row.url,
    state: row.state,
    path: row.path,
    line: row.line,
    targetName: row.target_name,
    targetId: row.target_id,
    deleted: row.deleted === 1,
    edited: row.edited === 1,
    reviewKind: row.review_kind,
    occurredAt: row.occurred_at,
    sourceUpdatedAt: row.source_updated_at,
  }
}

/** Typed access to the Durable Object's SQLite tables. */
export class Store {
  readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  // Deliveries

  /** Records a delivery ID; returns false if it was already seen. */
  claimDelivery(id: string, now: number): boolean {
    if (one(this.sql, "SELECT id FROM deliveries WHERE id = ?", id))
      return false
    this.sql.run(
      "INSERT INTO deliveries (id, received_at) VALUES (?, ?)",
      id,
      now,
    )
    return true
  }

  // Pull requests

  getPullRequest(id: string): PullRequestRecord | undefined {
    const row = one<PrRow>(this.sql, "SELECT * FROM prs WHERE id = ?", id)
    return row ? toPullRequest(row) : undefined
  }

  findByNumber(
    repositoryId: number,
    number: number,
  ): PullRequestRecord | undefined {
    return this.getPullRequest(pullRequestId(repositoryId, number))
  }

  findByHeadSha(repositoryId: number, sha: string): PullRequestRecord[] {
    return this.sql
      .all<PrRow>(
        "SELECT * FROM prs WHERE repo_id = ? AND head_sha = ?",
        repositoryId,
        sha,
      )
      .map(toPullRequest)
  }

  /** Writes a snapshot, keeping the stored parent link. */
  upsertPullRequest(snapshot: PullRequestSnapshot, now: number): void {
    const id = pullRequestId(snapshot.repositoryId, snapshot.number)
    const values: SqlValue[] = [
      id,
      snapshot.repositoryId,
      snapshot.repositoryFullName,
      snapshot.number,
      snapshot.title,
      snapshot.url,
      snapshot.author.id,
      snapshot.author.login,
      snapshot.author.avatarUrl,
      snapshot.status,
      snapshot.headRepositoryId,
      snapshot.headRef,
      snapshot.headSha,
      snapshot.baseRepositoryId,
      snapshot.baseRef,
      snapshot.defaultBranch,
      JSON.stringify(
        snapshot.reviewers.map(({ id, login, avatarUrl }) => ({
          id,
          login,
          avatarUrl,
        })),
      ),
      JSON.stringify(snapshot.reviewerTeams),
      snapshot.additions,
      snapshot.deletions,
      snapshot.changedFiles,
      snapshot.commitCount,
      snapshot.githubUpdatedAt,
      now,
    ]
    this.sql.run(
      `INSERT INTO prs (
        id, repo_id, repo, number, title, url, author_id, author_login,
        author_avatar, status, head_repo_id, head_ref, head_sha, base_repo_id,
        base_ref, default_branch, reviewers, reviewer_teams, additions,
        deletions, changed_files, commit_count, github_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        repo = excluded.repo,
        title = excluded.title,
        url = excluded.url,
        author_id = excluded.author_id,
        author_login = excluded.author_login,
        author_avatar = excluded.author_avatar,
        status = excluded.status,
        head_repo_id = excluded.head_repo_id,
        head_ref = excluded.head_ref,
        head_sha = excluded.head_sha,
        base_repo_id = excluded.base_repo_id,
        base_ref = excluded.base_ref,
        default_branch = COALESCE(excluded.default_branch, prs.default_branch),
        reviewers = excluded.reviewers,
        reviewer_teams = excluded.reviewer_teams,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        commit_count = excluded.commit_count,
        github_updated_at = excluded.github_updated_at,
        updated_at = excluded.updated_at`,
      ...values,
    )
  }

  setParent(id: string, parentId: string | null): void {
    this.sql.run(
      `UPDATE prs SET
        previous_parent_id = CASE WHEN parent_id IS NOT NULL AND parent_id IS NOT ? THEN parent_id ELSE previous_parent_id END,
        parent_id = ?
      WHERE id = ?`,
      parentId,
      parentId,
      id,
    )
  }

  /** PRs whose head branch is `ref` in `repositoryId`: parent candidates. */
  findByHead(repositoryId: number, ref: string): PullRequestRecord[] {
    return this.sql
      .all<PrRow>(
        "SELECT * FROM prs WHERE head_repo_id = ? AND head_ref = ?",
        repositoryId,
        ref,
      )
      .map(toPullRequest)
  }

  /** Open PRs whose base branch is `ref` in `repositoryId`: child candidates. */
  findOpenByBase(repositoryId: number, ref: string): PullRequestRecord[] {
    return this.sql
      .all<PrRow>(
        "SELECT * FROM prs WHERE base_repo_id = ? AND base_ref = ? AND status IN ('open', 'draft')",
        repositoryId,
        ref,
      )
      .map(toPullRequest)
  }

  children(id: string): PullRequestRecord[] {
    return this.sql
      .all<PrRow>("SELECT * FROM prs WHERE parent_id = ? ORDER BY number", id)
      .map(toPullRequest)
  }

  /** Walks parent links up to the stack's bottom PR. */
  findRoot(pr: PullRequestRecord): PullRequestRecord {
    let current = pr
    const seen = new Set([pr.id])
    for (let depth = 0; depth < MAX_PULL_REQUESTS_PER_STACK; depth += 1) {
      if (current.parentId === null || seen.has(current.parentId)) break
      const parent = this.getPullRequest(current.parentId)
      if (parent === undefined) break
      seen.add(parent.id)
      current = parent
    }
    return current
  }

  /** The root and everything stacked on it, breadth-first, capped. */
  stackMembers(root: PullRequestRecord): PullRequestRecord[] {
    const members = [root]
    const seen = new Set([root.id])
    for (
      let index = 0;
      index < members.length && members.length < MAX_PULL_REQUESTS_PER_STACK;
      index += 1
    ) {
      for (const child of this.children(members[index]!.id)) {
        if (seen.has(child.id)) continue
        if (members.length >= MAX_PULL_REQUESTS_PER_STACK) break
        seen.add(child.id)
        members.push(child)
      }
    }
    return members
  }

  // Checks, reviews, deployments

  /** Stores the latest result per check name; returns whether it changed. */
  upsertCheck(
    prId: string,
    check: CheckInput,
    currentHeadSha: string | null,
  ): boolean {
    const nameKey = check.name.trim().toLowerCase() || "ci"
    const existing = one<{
      head_sha: string
      updated_at: number
      state: string
    }>(
      this.sql,
      "SELECT head_sha, updated_at, state FROM pr_checks WHERE pr_id = ? AND source = ? AND name_key = ?",
      prId,
      check.source,
      nameKey,
    )
    if (existing) {
      const incomingCurrent = check.headSha === currentHeadSha
      const existingCurrent = existing.head_sha === currentHeadSha
      // Never let a late event for an old commit replace the current one.
      if (existingCurrent && !incomingCurrent) return false
      if (
        existingCurrent === incomingCurrent &&
        existing.head_sha === check.headSha &&
        existing.updated_at > check.updatedAt
      ) {
        return false
      }
      if (
        existing.head_sha === check.headSha &&
        existing.state === check.state &&
        existing.updated_at === check.updatedAt
      ) {
        return false
      }
    }
    this.sql.run(
      `INSERT INTO pr_checks (pr_id, source, name_key, name, state, url, head_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_id, source, name_key) DO UPDATE SET
         name = excluded.name, state = excluded.state, url = excluded.url,
         head_sha = excluded.head_sha, updated_at = excluded.updated_at`,
      prId,
      check.source,
      nameKey,
      check.name,
      check.state,
      check.url,
      check.headSha,
      check.updatedAt,
    )
    return true
  }

  checksFor(prIds: ReadonlyArray<string>): CheckRow[] {
    return this.#forPrs<{
      pr_id: string
      source: "check_run" | "status"
      name: string
      state: string
      url: string | null
      head_sha: string
      updated_at: number
    }>("SELECT * FROM pr_checks", prIds).map((row) => ({
      prId: row.pr_id,
      source: row.source,
      name: row.name,
      state: row.state,
      url: row.url,
      headSha: row.head_sha,
      updatedAt: row.updated_at,
    }))
  }

  upsertReview(
    prId: string,
    review: {
      reviewerId: number
      login: string
      state: ReviewState
      updatedAt: number
    },
  ): void {
    this.sql.run(
      `INSERT INTO pr_reviews (pr_id, reviewer_id, login, state, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (pr_id, reviewer_id) DO UPDATE SET
         login = excluded.login, state = excluded.state, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= pr_reviews.updated_at`,
      prId,
      review.reviewerId,
      review.login,
      review.state,
      review.updatedAt,
    )
  }

  clearReview(prId: string, reviewerId: number): void {
    this.sql.run(
      "DELETE FROM pr_reviews WHERE pr_id = ? AND reviewer_id = ?",
      prId,
      reviewerId,
    )
  }

  reviewsFor(prIds: ReadonlyArray<string>): ReviewRow[] {
    return this.#forPrs<{
      pr_id: string
      reviewer_id: number
      login: string
      state: ReviewState
      updated_at: number
    }>("SELECT * FROM pr_reviews", prIds).map((row) => ({
      prId: row.pr_id,
      reviewerId: row.reviewer_id,
      login: row.login,
      state: row.state,
      updatedAt: row.updated_at,
    }))
  }

  upsertDeployment(
    prId: string,
    deployment: {
      environment: string
      state: string
      url: string | null
      headSha: string
      updatedAt: number
    },
  ): void {
    this.sql.run(
      `INSERT INTO pr_deployments (pr_id, environment, state, url, head_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_id) DO UPDATE SET
         environment = excluded.environment, state = excluded.state,
         url = excluded.url, head_sha = excluded.head_sha, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= pr_deployments.updated_at`,
      prId,
      deployment.environment,
      deployment.state,
      deployment.url,
      deployment.headSha,
      deployment.updatedAt,
    )
  }

  deploymentsFor(prIds: ReadonlyArray<string>): DeploymentRow[] {
    return this.#forPrs<{
      pr_id: string
      state: string
      head_sha: string
      updated_at: number
    }>("SELECT * FROM pr_deployments", prIds).map((row) => ({
      prId: row.pr_id,
      state: row.state,
      headSha: row.head_sha,
      updatedAt: row.updated_at,
    }))
  }

  // Thread items

  getItem(id: string): ItemRecord | undefined {
    const row = one<ItemRow>(this.sql, "SELECT * FROM items WHERE id = ?", id)
    return row ? toItem(row) : undefined
  }

  /** Inserts or updates an item; returns null if the stored copy is newer. */
  upsertItem(
    prId: string,
    input: ThreadItemInput,
    now: number,
  ): { item: ItemRecord; created: boolean } | null {
    const id = `${prId}:${input.externalKey}`
    const existing = this.getItem(id)
    if (existing && existing.sourceUpdatedAt > input.sourceUpdatedAt) {
      return null
    }
    this.sql.run(
      `INSERT INTO items (
        id, pr_id, kind, action, actor_id, actor_login, actor_avatar, body, url,
        state, path, line, target_name, target_id, deleted, edited, occurred_at,
        source_updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        action = excluded.action,
        actor_login = COALESCE(excluded.actor_login, items.actor_login),
        actor_avatar = COALESCE(excluded.actor_avatar, items.actor_avatar),
        body = CASE WHEN excluded.deleted = 1 THEN items.body ELSE excluded.body END,
        url = COALESCE(excluded.url, items.url),
        state = excluded.state,
        path = COALESCE(excluded.path, items.path),
        line = COALESCE(excluded.line, items.line),
        deleted = MAX(items.deleted, excluded.deleted),
        edited = MAX(items.edited, excluded.edited),
        source_updated_at = excluded.source_updated_at`,
      id,
      prId,
      input.kind,
      input.action,
      input.actor?.id ?? null,
      input.actor?.login ?? null,
      input.actor?.avatarUrl ?? null,
      input.body,
      input.url,
      input.state,
      input.path,
      input.line,
      input.targetName,
      input.targetId,
      input.deleted ? 1 : 0,
      input.action === "edited" ? 1 : 0,
      input.occurredAt,
      input.sourceUpdatedAt,
      now,
    )
    return { item: this.getItem(id)!, created: existing === undefined }
  }

  markItemDeleted(id: string): void {
    this.sql.run("UPDATE items SET deleted = 1 WHERE id = ?", id)
  }

  setReviewKind(id: string, kind: ReviewNotificationKind | null): void {
    this.sql.run("UPDATE items SET review_kind = ? WHERE id = ?", kind, id)
  }

  itemsFor(prIds: ReadonlyArray<string>, limit: number): ItemRecord[] {
    if (prIds.length === 0) return []
    return this.sql
      .all<ItemRow>(
        `SELECT * FROM items WHERE pr_id IN (${placeholders(prIds)}) ORDER BY occurred_at LIMIT ?`,
        ...prIds,
        limit,
      )
      .map(toItem)
  }

  /** Pending review-request items for a target, for retraction. */
  reviewRequestItems(
    prId: string,
    targetType: string,
    targetId: number,
  ): ItemRecord[] {
    return this.sql
      .all<ItemRow>(
        `SELECT * FROM items WHERE pr_id = ? AND kind = 'pull_request'
         AND action = 'review_requested' AND state = ? AND target_id = ? AND deleted = 0`,
        prId,
        targetType,
        targetId,
      )
      .map(toItem)
  }

  reviewHistory(prId: string): Array<{
    targetType: "user" | "team"
    targetId: number
    kind: "request" | "review"
    hasApproved: boolean
    occurredAt: number
  }> {
    return this.sql
      .all<{
        target_type: "user" | "team"
        target_id: number
        kind: "request" | "review"
        has_approved: number
        occurred_at: number
      }>(
        "SELECT target_type, target_id, kind, has_approved, occurred_at FROM review_history WHERE pr_id = ?",
        prId,
      )
      .map((row) => ({
        targetType: row.target_type,
        targetId: row.target_id,
        kind: row.kind,
        hasApproved: row.has_approved === 1,
        occurredAt: row.occurred_at,
      }))
  }

  recordReviewHistory(entry: {
    itemId: string
    prId: string
    targetType: "user" | "team"
    targetId: number
    kind: "request" | "review"
    hasApproved: boolean
    occurredAt: number
  }): void {
    this.sql.run(
      `INSERT INTO review_history (item_id, pr_id, target_type, target_id, kind, has_approved, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET has_approved = MAX(review_history.has_approved, excluded.has_approved)`,
      entry.itemId,
      entry.prId,
      entry.targetType,
      entry.targetId,
      entry.kind,
      entry.hasApproved ? 1 : 0,
      entry.occurredAt,
    )
  }

  // Messages

  getMessage(key: string): MessageRecord | undefined {
    const row = one<{
      key: string
      pr_id: string
      channel: string
      ts: string
      thread_ts: string | null
      render_key: string
    }>(this.sql, "SELECT * FROM messages WHERE key = ?", key)
    return row
      ? {
          key: row.key,
          prId: row.pr_id,
          channel: row.channel,
          ts: row.ts,
          threadTs: row.thread_ts,
          renderKey: row.render_key,
        }
      : undefined
  }

  /** The root message whose thread is (`channel`, `ts`). */
  findRootMessageByTs(channel: string, ts: string): MessageRecord | undefined {
    const row = one<{ key: string }>(
      this.sql,
      "SELECT key FROM messages WHERE channel = ? AND ts = ? AND key LIKE 'root:%'",
      channel,
      ts,
    )
    return row ? this.getMessage(row.key) : undefined
  }

  saveMessage(message: MessageRecord, now: number): void {
    this.sql.run(
      `INSERT INTO messages (key, pr_id, channel, ts, thread_ts, render_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         pr_id = excluded.pr_id, channel = excluded.channel, ts = excluded.ts,
         thread_ts = excluded.thread_ts, render_key = excluded.render_key,
         updated_at = excluded.updated_at`,
      message.key,
      message.prId,
      message.channel,
      message.ts,
      message.threadTs,
      message.renderKey,
      now,
    )
  }

  deleteMessage(key: string): void {
    this.sql.run("DELETE FROM messages WHERE key = ?", key)
  }

  /** Moves a root message to a new key, e.g. when a stack's bottom PR merges. */
  renameMessage(fromKey: string, toKey: string, prId: string): void {
    this.sql.run(
      "UPDATE messages SET key = ?, pr_id = ? WHERE key = ?",
      toKey,
      prId,
      fromKey,
    )
  }

  /** Thread replies stackping posted under a root message. */
  repliesInThread(channel: string, threadTs: string): MessageRecord[] {
    return this.sql
      .all<{ key: string }>(
        "SELECT key FROM messages WHERE channel = ? AND thread_ts = ?",
        channel,
        threadTs,
      )
      .map((row) => this.getMessage(row.key)!)
  }

  /** Whether people replied in Slack under this PR's root message. */
  hasHumanReplies(prId: string): boolean {
    return (
      one(
        this.sql,
        "SELECT 1 FROM reply_links WHERE pr_id = ? LIMIT 1",
        prId,
      ) !== undefined
    )
  }

  // Outbox

  /**
   * Schedules work. Repeated enqueues of the same key coalesce: the earliest
   * due time wins, the latest payload wins, and dead jobs come back to life.
   */
  enqueue(
    key: string,
    options: {
      readonly channel: string | null
      readonly dueAt: number
      readonly payload?: string | null
      readonly now: number
    },
  ): void {
    this.sql.run(
      `INSERT INTO outbox (key, channel, payload, due_at, rev, attempts, last_error, dead, created_at)
       VALUES (?, ?, ?, ?, 1, 0, NULL, 0, ?)
       ON CONFLICT (key) DO UPDATE SET
         channel = excluded.channel,
         payload = COALESCE(excluded.payload, outbox.payload),
         due_at = CASE WHEN outbox.dead = 1 THEN excluded.due_at ELSE MIN(outbox.due_at, excluded.due_at) END,
         rev = outbox.rev + 1,
         attempts = CASE WHEN outbox.dead = 1 THEN 0 ELSE outbox.attempts END,
         dead = 0,
         created_at = CASE WHEN outbox.dead = 1 THEN excluded.created_at ELSE outbox.created_at END`,
      key,
      options.channel,
      options.payload ?? null,
      options.dueAt,
      options.now,
    )
  }

  getJob(key: string): OutboxRecord | undefined {
    const row = one<{
      key: string
      channel: string | null
      payload: string | null
      due_at: number
      rev: number
      attempts: number
      created_at: number
    }>(this.sql, "SELECT * FROM outbox WHERE key = ? AND dead = 0", key)
    return row
      ? {
          key: row.key,
          channel: row.channel,
          payload: row.payload,
          dueAt: row.due_at,
          rev: row.rev,
          attempts: row.attempts,
          createdAt: row.created_at,
        }
      : undefined
  }

  dueJobs(now: number, limit: number): OutboxRecord[] {
    return this.sql
      .all<{
        key: string
        channel: string | null
        payload: string | null
        due_at: number
        rev: number
        attempts: number
        created_at: number
      }>(
        "SELECT * FROM outbox WHERE dead = 0 AND due_at <= ? ORDER BY due_at, key LIMIT ?",
        now,
        limit,
      )
      .map((row) => ({
        key: row.key,
        channel: row.channel,
        payload: row.payload,
        dueAt: row.due_at,
        rev: row.rev,
        attempts: row.attempts,
        createdAt: row.created_at,
      }))
  }

  nextDueAt(): number | null {
    return (
      one<{ due: number | null }>(
        this.sql,
        "SELECT MIN(due_at) AS due FROM outbox WHERE dead = 0",
      )?.due ?? null
    )
  }

  /** Completes a job unless it was re-enqueued while it ran. */
  completeJob(key: string, rev: number): void {
    this.sql.run("DELETE FROM outbox WHERE key = ? AND rev = ?", key, rev)
  }

  rescheduleJob(
    key: string,
    rev: number,
    dueAt: number,
    options: { attempts?: number; error?: string | null } = {},
  ): void {
    this.sql.run(
      `UPDATE outbox SET due_at = ?, attempts = COALESCE(?, attempts), last_error = COALESCE(?, last_error)
       WHERE key = ? AND rev = ?`,
      dueAt,
      options.attempts ?? null,
      options.error ?? null,
      key,
      rev,
    )
    // A newer enqueue already set its own due time; just record the error.
    if (options.error) {
      this.sql.run(
        "UPDATE outbox SET last_error = ? WHERE key = ? AND rev != ?",
        options.error,
        key,
        rev,
      )
    }
  }

  killJob(key: string, rev: number, error: string): void {
    this.sql.run(
      "UPDATE outbox SET dead = 1, last_error = ? WHERE key = ? AND rev = ?",
      error,
      key,
      rev,
    )
  }

  outboxCounts(): { pending: number; dead: number } {
    const row = one<{ pending: number; dead: number }>(
      this.sql,
      "SELECT COALESCE(SUM(dead = 0), 0) AS pending, COALESCE(SUM(dead = 1), 0) AS dead FROM outbox",
    )
    return { pending: row?.pending ?? 0, dead: row?.dead ?? 0 }
  }

  deadJobs(limit: number): Array<{ key: string; error: string | null }> {
    return this.sql.all<{ key: string; error: string | null }>(
      "SELECT key, last_error AS error FROM outbox WHERE dead = 1 ORDER BY due_at DESC LIMIT ?",
      limit,
    )
  }

  // Reply links

  getReplyLink(
    slackKey: string,
  ): { prId: string; commentId: number; lastEventTime: number } | undefined {
    const row = one<{
      pr_id: string
      comment_id: number
      last_event_time: number
    }>(this.sql, "SELECT * FROM reply_links WHERE slack_key = ?", slackKey)
    return row
      ? {
          prId: row.pr_id,
          commentId: row.comment_id,
          lastEventTime: row.last_event_time,
        }
      : undefined
  }

  saveReplyLink(
    slackKey: string,
    link: { prId: string; commentId: number; lastEventTime: number },
  ): void {
    this.sql.run(
      `INSERT INTO reply_links (slack_key, pr_id, comment_id, last_event_time) VALUES (?, ?, ?, ?)
       ON CONFLICT (slack_key) DO UPDATE SET comment_id = excluded.comment_id, last_event_time = excluded.last_event_time`,
      slackKey,
      link.prId,
      link.commentId,
      link.lastEventTime,
    )
  }

  deleteReplyLink(slackKey: string): void {
    this.sql.run("DELETE FROM reply_links WHERE slack_key = ?", slackKey)
  }

  // Slack profiles

  getProfile(
    userId: string,
  ):
    | { name: string | null; avatarUrl: string | null; fetchedAt: number }
    | undefined {
    const row = one<{
      name: string | null
      avatar_url: string | null
      fetched_at: number
    }>(
      this.sql,
      "SELECT name, avatar_url, fetched_at FROM slack_profiles WHERE user_id = ?",
      userId,
    )
    return row
      ? { name: row.name, avatarUrl: row.avatar_url, fetchedAt: row.fetched_at }
      : undefined
  }

  saveProfile(
    userId: string,
    profile: { name: string | null; avatarUrl: string | null },
    now: number,
  ): void {
    this.sql.run(
      `INSERT INTO slack_profiles (user_id, name, avatar_url, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url, fetched_at = excluded.fetched_at`,
      userId,
      profile.name,
      profile.avatarUrl,
      now,
    )
  }

  // Meta

  getMeta(key: string): string | undefined {
    return one<{ value: string }>(
      this.sql,
      "SELECT value FROM meta WHERE key = ?",
      key,
    )?.value
  }

  setMeta(key: string, value: string): void {
    this.sql.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    )
  }

  // Retention

  prune(now: number): void {
    const day = 24 * 60 * 60 * 1000
    this.sql.run("DELETE FROM deliveries WHERE received_at < ?", now - 3 * day)
    this.sql.run(
      "DELETE FROM outbox WHERE dead = 1 AND due_at < ?",
      now - 14 * day,
    )
    const stale = this.sql.all<{ id: string }>(
      "SELECT id FROM prs WHERE status IN ('closed', 'merged') AND github_updated_at < ? LIMIT 200",
      now - 30 * day,
    )
    // Callers run this inside a transaction.
    for (const { id } of stale) {
      for (const table of [
        "pr_checks",
        "pr_reviews",
        "pr_deployments",
        "review_history",
        "messages",
        "reply_links",
        "items",
      ]) {
        this.sql.run(`DELETE FROM ${table} WHERE pr_id = ?`, id)
      }
      this.sql.run("UPDATE prs SET parent_id = NULL WHERE parent_id = ?", id)
      this.sql.run("DELETE FROM prs WHERE id = ?", id)
    }
  }

  #forPrs<T>(select: string, prIds: ReadonlyArray<string>): T[] {
    if (prIds.length === 0) return []
    return this.sql.all<T>(
      `${select} WHERE pr_id IN (${placeholders(prIds)})`,
      ...prIds,
    )
  }
}

function placeholders(values: ReadonlyArray<unknown>): string {
  return values.map(() => "?").join(", ")
}
