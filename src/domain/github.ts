import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * GitHub webhook events stackping subscribes to. `workflow_run`,
 * `workflow_job`, `check_suite`, and `push` are intentionally absent: Actions
 * jobs already emit check runs, and `pull_request.synchronize` covers pushes.
 */
export const GITHUB_WEBHOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
  "check_run",
  "status",
  "deployment_status",
] as const

export type GitHubWebhookEvent = (typeof GITHUB_WEBHOOK_EVENTS)[number]

export interface GitHubUser {
  readonly id: number
  readonly login: string
  readonly avatarUrl: string | null
}

export interface GitHubTeam {
  readonly id: number
  readonly name: string
  readonly slug: string
}

export type PullRequestStatus = "draft" | "open" | "closed" | "merged"

/** The state of a pull request as of `githubUpdatedAt`. */
export interface PullRequestSnapshot {
  readonly repositoryId: number
  readonly repositoryFullName: string
  readonly defaultBranch: string | null
  readonly number: number
  readonly title: string
  readonly url: string
  readonly author: GitHubUser
  readonly status: PullRequestStatus
  readonly headRepositoryId: number
  readonly headRef: string
  readonly headSha: string | null
  readonly baseRepositoryId: number
  readonly baseRef: string
  readonly reviewers: ReadonlyArray<GitHubUser>
  readonly reviewerTeams: ReadonlyArray<GitHubTeam>
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly commitCount: number
  readonly githubUpdatedAt: number
}

export interface PullRequestEvent {
  readonly action: string
  readonly sender: GitHubUser
  readonly requestedReviewer: GitHubUser | null
  readonly requestedTeam: GitHubTeam | null
  readonly beforeSha: string | null
  readonly afterSha: string | null
  readonly pullRequest: PullRequestSnapshot
}

export type ThreadItemKind =
  | "pull_request"
  | "comment"
  | "review"
  | "review_comment"
  | "review_thread"

/** Human activity that may become a reply in the stack's Slack thread. */
export interface ThreadItemInput {
  /** Unique per repository and pull request; stable across edits. */
  readonly externalKey: string
  readonly kind: ThreadItemKind
  readonly action: string
  readonly actor: GitHubUser | null
  readonly body: string | null
  readonly url: string | null
  readonly state: string | null
  readonly path: string | null
  readonly line: number | null
  /** Review request target (user login or team slug). */
  readonly targetName: string | null
  readonly targetId: number | null
  readonly deleted: boolean
  readonly occurredAt: number
  readonly sourceUpdatedAt: number
}

export interface CheckInput {
  readonly source: "check_run" | "status"
  readonly name: string
  readonly state: string
  readonly url: string | null
  readonly body: string | null
  readonly headSha: string
  readonly updatedAt: number
}

export interface DeploymentInput {
  readonly environment: string
  readonly state: string
  readonly url: string | null
  readonly ref: string
  readonly headSha: string
  readonly updatedAt: number
}

export interface ActivityEvent {
  readonly repositoryId: number
  readonly repositoryFullName: string
  readonly pullRequestNumbers: ReadonlyArray<number>
  readonly activity:
    | { readonly type: "thread"; readonly item: ThreadItemInput }
    | { readonly type: "check"; readonly check: CheckInput }
    | { readonly type: "deployment"; readonly deployment: DeploymentInput }
}

const user = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
})

const team = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  slug: Schema.String,
})

const repository = Schema.Struct({
  id: Schema.Number,
  full_name: Schema.String,
  default_branch: Schema.optional(Schema.String),
})

const pullRequestReference = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.optional(Schema.String),
})

const pullRequestEvent = Schema.Struct({
  action: Schema.String,
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  requested_reviewer: Schema.optional(user),
  requested_team: Schema.optional(team),
  repository,
  sender: Schema.optional(user),
  pull_request: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    html_url: Schema.String,
    state: Schema.Literals(["open", "closed"]),
    draft: Schema.optional(Schema.Boolean),
    merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
    merged_at: Schema.optional(Schema.NullOr(Schema.String)),
    updated_at: Schema.String,
    user,
    requested_reviewers: Schema.optional(Schema.Array(user)),
    requested_teams: Schema.optional(Schema.Array(team)),
    additions: Schema.optional(Schema.Number),
    deletions: Schema.optional(Schema.Number),
    changed_files: Schema.optional(Schema.Number),
    commits: Schema.optional(Schema.Number),
    head: Schema.Struct({
      ref: Schema.String,
      sha: Schema.optional(Schema.String),
      repo: Schema.NullOr(Schema.Struct({ id: Schema.Number })),
    }),
    base: Schema.Struct({
      ref: Schema.String,
      repo: Schema.Struct({ id: Schema.Number }),
    }),
  }),
})

const issueCommentEvent = Schema.Struct({
  action: Schema.String,
  repository,
  issue: Schema.Struct({
    number: Schema.Number,
    pull_request: Schema.optional(Schema.Unknown),
  }),
  comment: Schema.Struct({
    id: Schema.Number,
    body: Schema.NullOr(Schema.String),
    html_url: Schema.String,
    user,
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
})

const reviewEvent = Schema.Struct({
  action: Schema.String,
  repository,
  pull_request: pullRequestReference,
  review: Schema.Struct({
    id: Schema.Number,
    body: Schema.NullOr(Schema.String),
    html_url: Schema.String,
    state: Schema.String,
    user: Schema.NullOr(user),
    submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const reviewCommentEvent = Schema.Struct({
  action: Schema.String,
  repository,
  pull_request: pullRequestReference,
  comment: Schema.Struct({
    id: Schema.Number,
    body: Schema.String,
    html_url: Schema.String,
    user,
    path: Schema.String,
    line: Schema.optional(Schema.NullOr(Schema.Number)),
    original_line: Schema.optional(Schema.NullOr(Schema.Number)),
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
})

const reviewThreadEvent = Schema.Struct({
  action: Schema.String,
  repository,
  sender: Schema.optional(user),
  pull_request: pullRequestReference,
  thread: Schema.Struct({
    node_id: Schema.optional(Schema.String),
    comments: Schema.optional(
      Schema.Array(
        Schema.Struct({ updated_at: Schema.optional(Schema.String) }),
      ),
    ),
  }),
})

const checkRunEvent = Schema.Struct({
  repository,
  check_run: Schema.Struct({
    id: Schema.Number,
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    head_sha: Schema.String,
    html_url: Schema.NullOr(Schema.String),
    details_url: Schema.optional(Schema.NullOr(Schema.String)),
    started_at: Schema.NullOr(Schema.String),
    completed_at: Schema.NullOr(Schema.String),
    pull_requests: Schema.Array(pullRequestReference),
    output: Schema.optional(
      Schema.Struct({
        title: Schema.NullOr(Schema.String),
        summary: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})

const statusEvent = Schema.Struct({
  repository,
  sha: Schema.String,
  context: Schema.String,
  state: Schema.String,
  description: Schema.NullOr(Schema.String),
  target_url: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
})

const deploymentStatusEvent = Schema.Struct({
  repository,
  deployment: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    environment: Schema.String,
  }),
  deployment_status: Schema.Struct({
    state: Schema.String,
    target_url: Schema.optional(Schema.NullOr(Schema.String)),
    environment_url: Schema.optional(Schema.NullOr(Schema.String)),
    log_url: Schema.optional(Schema.NullOr(Schema.String)),
    updated_at: Schema.String,
  }),
})

export function parsePullRequestEvent(
  parsed: unknown,
): PullRequestEvent | null {
  const decoded = Schema.decodeUnknownOption(pullRequestEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const raw = decoded.value
  const pr = raw.pull_request
  const githubUpdatedAt = Date.parse(pr.updated_at)
  if (!Number.isFinite(githubUpdatedAt)) return null

  const merged = pr.merged === true || Boolean(pr.merged_at)
  const status: PullRequestStatus = merged
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : pr.draft
        ? "draft"
        : "open"

  return {
    action: raw.action,
    sender: toUser(raw.sender ?? pr.user),
    requestedReviewer: raw.requested_reviewer
      ? toUser(raw.requested_reviewer)
      : null,
    requestedTeam: raw.requested_team ?? null,
    beforeSha: raw.before ?? null,
    afterSha: raw.after ?? pr.head.sha ?? null,
    pullRequest: {
      repositoryId: raw.repository.id,
      repositoryFullName: raw.repository.full_name,
      defaultBranch: raw.repository.default_branch ?? null,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: toUser(pr.user),
      status,
      // A fork whose repository was deleted has a null head repo.
      headRepositoryId: pr.head.repo?.id ?? -1,
      headRef: pr.head.ref,
      headSha: pr.head.sha ?? null,
      baseRepositoryId: pr.base.repo.id,
      baseRef: pr.base.ref,
      reviewers: uniqueById((pr.requested_reviewers ?? []).map(toUser)),
      reviewerTeams: uniqueById(pr.requested_teams ?? []),
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changed_files ?? 0,
      commitCount: pr.commits ?? 0,
      githubUpdatedAt,
    },
  }
}

/** Thread activity carried by a `pull_request` event itself. */
export function threadItemFromPullRequestEvent(
  event: PullRequestEvent,
): ThreadItemInput | null {
  const pr = event.pullRequest
  const base = {
    actor: event.sender,
    body: null,
    url: pr.url,
    path: null,
    line: null,
    deleted: false,
    occurredAt: pr.githubUpdatedAt,
    sourceUpdatedAt: pr.githubUpdatedAt,
  }

  if (event.action === "ready_for_review") {
    return {
      ...base,
      externalKey: "ready_for_review",
      kind: "pull_request",
      action: event.action,
      state: "ready_for_review",
      targetName: null,
      targetId: null,
    }
  }

  if (event.action === "review_requested") {
    const target = event.requestedReviewer
      ? {
          type: "user",
          id: event.requestedReviewer.id,
          name: event.requestedReviewer.login,
        }
      : event.requestedTeam
        ? {
            type: "team",
            id: event.requestedTeam.id,
            name: event.requestedTeam.slug,
          }
        : null
    if (target === null) return null

    // Each request is a distinct item so a re-request pings again.
    return {
      ...base,
      externalKey: `review_requested:${target.type}:${target.id}:${pr.githubUpdatedAt}`,
      kind: "pull_request",
      action: event.action,
      state: target.type,
      targetName: target.name,
      targetId: target.id,
    }
  }

  if (event.action === "closed" && pr.status === "merged") {
    return {
      ...base,
      externalKey: "merged",
      kind: "pull_request",
      action: event.action,
      state: "merged",
      targetName: null,
      targetId: null,
    }
  }

  return null
}

export function parseActivityEvent(
  event: string,
  parsed: unknown,
): ActivityEvent | null {
  switch (event) {
    case "issue_comment":
      return parseIssueComment(parsed)
    case "pull_request_review":
      return parseReview(parsed)
    case "pull_request_review_comment":
      return parseReviewComment(parsed)
    case "pull_request_review_thread":
      return parseReviewThread(parsed)
    case "check_run":
      return parseCheckRun(parsed)
    case "status":
      return parseStatus(parsed)
    case "deployment_status":
      return parseDeploymentStatus(parsed)
    default:
      return null
  }
}

function parseIssueComment(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(issueCommentEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value
  if (value.issue.pull_request === undefined) return null

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: [value.issue.number],
    activity: {
      type: "thread",
      item: {
        externalKey: `comment:${value.comment.id}`,
        kind: "comment",
        action: value.action,
        actor: toUser(value.comment.user),
        body: value.comment.body,
        url: value.comment.html_url,
        state: null,
        path: null,
        line: null,
        targetName: null,
        targetId: null,
        deleted: value.action === "deleted",
        occurredAt: timestamp(value.comment.created_at),
        sourceUpdatedAt: timestamp(value.comment.updated_at),
      },
    },
  }
}

function parseReview(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(reviewEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value
  const submittedAt = timestamp(value.review.submitted_at)

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: [value.pull_request.number],
    activity: {
      type: "thread",
      item: {
        externalKey: `review:${value.review.id}`,
        kind: "review",
        action: value.action,
        actor: value.review.user ? toUser(value.review.user) : null,
        body: value.review.body,
        url: value.review.html_url,
        state:
          value.action === "dismissed"
            ? "dismissed"
            : value.review.state.toLowerCase(),
        path: null,
        line: null,
        targetName: null,
        targetId: null,
        deleted: false,
        occurredAt: submittedAt,
        // A dismissal arrives with the original submitted_at; it must still
        // supersede the review it dismisses.
        sourceUpdatedAt:
          value.action === "dismissed" ? Date.now() : submittedAt,
      },
    },
  }
}

function parseReviewComment(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(reviewCommentEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: [value.pull_request.number],
    activity: {
      type: "thread",
      item: {
        externalKey: `review_comment:${value.comment.id}`,
        kind: "review_comment",
        action: value.action,
        actor: toUser(value.comment.user),
        body: value.comment.body,
        url: value.comment.html_url,
        state: null,
        path: value.comment.path,
        line: value.comment.line ?? value.comment.original_line ?? null,
        targetName: null,
        targetId: null,
        deleted: value.action === "deleted",
        occurredAt: timestamp(value.comment.created_at),
        sourceUpdatedAt: timestamp(value.comment.updated_at),
      },
    },
  }
}

function parseReviewThread(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(reviewThreadEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value
  if (value.action !== "resolved" && value.action !== "unresolved") return null
  const now = Date.now()
  const threadId =
    value.thread.node_id ??
    value.thread.comments?.[0]?.updated_at ??
    String(now)

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: [value.pull_request.number],
    activity: {
      type: "thread",
      item: {
        externalKey: `review_thread:${threadId}:${value.action}:${now}`,
        kind: "review_thread",
        action: value.action,
        actor: value.sender ? toUser(value.sender) : null,
        body: null,
        url: value.pull_request.html_url ?? null,
        state: value.action,
        path: null,
        line: null,
        targetName: null,
        targetId: null,
        deleted: false,
        occurredAt: now,
        sourceUpdatedAt: now,
      },
    },
  }
}

function parseCheckRun(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(checkRunEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value
  const run = value.check_run
  const output = run.output
  const body = output
    ? [output.title, output.summary].filter((part) => part !== null).join("\n")
    : ""

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: run.pull_requests.map((pr) => pr.number),
    activity: {
      type: "check",
      check: {
        source: "check_run",
        name: run.name,
        state: (run.conclusion ?? run.status).toLowerCase(),
        url: run.html_url ?? run.details_url ?? null,
        body: body || null,
        headSha: run.head_sha,
        updatedAt: timestamp(run.completed_at ?? run.started_at),
      },
    },
  }
}

function parseStatus(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(statusEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: [],
    activity: {
      type: "check",
      check: {
        source: "status",
        name: value.context,
        state: value.state.toLowerCase(),
        url: value.target_url,
        body: value.description,
        headSha: value.sha,
        updatedAt: timestamp(value.updated_at),
      },
    },
  }
}

function parseDeploymentStatus(parsed: unknown): ActivityEvent | null {
  const decoded = Schema.decodeUnknownOption(deploymentStatusEvent)(parsed)
  if (Option.isNone(decoded)) return null
  const value = decoded.value
  const status = value.deployment_status

  return {
    repositoryId: value.repository.id,
    repositoryFullName: value.repository.full_name,
    pullRequestNumbers: [],
    activity: {
      type: "deployment",
      deployment: {
        environment: value.deployment.environment,
        state: status.state.toLowerCase(),
        url:
          status.environment_url || status.log_url || status.target_url || null,
        ref: value.deployment.ref,
        headSha: value.deployment.sha,
        updatedAt: timestamp(status.updated_at),
      },
    },
  }
}

export async function verifyGitHubSignature(
  payload: string,
  secret: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=") || signature.length !== 71) {
    return false
  }
  const expected = `sha256=${await hmacSha256Hex(secret, payload)}`
  return constantTimeEqual(expected, signature)
}

export async function hmacSha256Hex(
  secret: string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  )
  return toHex(new Uint8Array(digest))
}

export function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return mismatch === 0
}

export function graphitePullRequestUrl(
  repositoryFullName: string,
  number: number,
): string {
  const path = repositoryFullName.split("/").map(encodeURIComponent).join("/")
  return `https://app.graphite.com/github/pr/${path}/${number}`
}

function toUser(value: {
  readonly id: number
  readonly login: string
  readonly avatar_url?: string | null | undefined
}): GitHubUser {
  return {
    id: value.id,
    login: value.login,
    avatarUrl: value.avatar_url ?? null,
  }
}

function uniqueById<T extends { readonly id: number }>(
  values: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(
    (left, right) => left.id - right.id,
  )
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
