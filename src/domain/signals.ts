import type { ThreadItemKind } from "./github.ts"

export type ReviewState = "approved" | "changes_requested" | "waiting"

export interface SignalPullRequest {
  readonly id: string
  readonly headSha: string | null
  readonly reviewers: ReadonlyArray<{
    readonly id: number
    readonly login: string
  }>
  readonly reviewerTeams: ReadonlyArray<{
    readonly id: number
    readonly slug: string
  }>
}

export interface CheckRow {
  readonly prId: string
  readonly source: "check_run" | "status"
  readonly name: string
  readonly state: string
  readonly url: string | null
  readonly headSha: string
  readonly updatedAt: number
}

export interface ReviewRow {
  readonly prId: string
  readonly reviewerId: number
  readonly login: string
  readonly state: ReviewState
  readonly updatedAt: number
}

export interface DeploymentRow {
  readonly prId: string
  readonly state: string
  readonly headSha: string
  readonly updatedAt: number
}

export interface BuildSignal {
  readonly passing: number
  readonly failing: number
  readonly pending: number
  readonly failures: ReadonlyArray<{
    readonly name: string
    readonly url: string | null
  }>
}

export interface StackSignals {
  readonly build: BuildSignal
  readonly reviewers: ReadonlyArray<{
    readonly id: number
    readonly login: string
    readonly state: ReviewState
  }>
  readonly reviewerTeams: ReadonlyArray<{
    readonly id: number
    readonly slug: string
  }>
  readonly approvedPullRequestIds: ReadonlyArray<string>
  readonly deployment: "ready" | "failing" | "deploying" | null
}

export type ThreadDeliveryMode = "ignore" | "thread" | "thread_and_root"

const failureStates = new Set([
  "action_required",
  "error",
  "failure",
  "startup_failure",
  "timed_out",
])
const passingStates = new Set(["success"])
const ignoredStates = new Set([
  "cancelled",
  "canceled",
  "neutral",
  "skipped",
  "stale",
])

/** Whether a thread item belongs in Slack, and whether it changes the root. */
export function threadDeliveryMode(item: {
  readonly kind: ThreadItemKind
  readonly action: string
  readonly actorLogin: string | null
  readonly body: string | null
  readonly state: string | null
}): ThreadDeliveryMode {
  switch (item.kind) {
    case "comment":
      if (isGraphiteMergeQueueComment(item.body)) return "thread"
      if (isSlackEcho(item.body)) return "ignore"
      return isAutomatedActor(item.actorLogin) || isAutomatedComment(item.body)
        ? "ignore"
        : "thread"
    case "pull_request":
      return "thread_and_root"
    case "review": {
      if (isAutomatedActor(item.actorLogin)) return "ignore"
      const state = normalizeState(item.state)
      return state === "approved" ||
        state === "changes_requested" ||
        state === "dismissed" ||
        Boolean(item.body?.trim())
        ? "thread_and_root"
        : "ignore"
    }
    case "review_comment":
    case "review_thread":
      return isAutomatedActor(item.actorLogin) ? "ignore" : "thread"
  }
}

/** Checks that never count toward CI totals. */
export function isIgnoredCheck(check: {
  readonly state: string
  readonly body: string | null
}): boolean {
  return (
    ignoredStates.has(normalizeState(check.state)) ||
    // Vercel reports skipped deploys as "Canceled by Ignored Build Step".
    /ignored build step/i.test(check.body ?? "")
  )
}

/** The decisive review state a review carries, or null if it changes none. */
export function reviewStateFor(state: string | null): ReviewState | null {
  switch (normalizeState(state)) {
    case "approved":
      return "approved"
    case "changes_requested":
      return "changes_requested"
    case "dismissed":
      return "waiting"
    default:
      return null
  }
}

/** Identifies a stack's exact set of commits; CI summaries are per revision. */
export function stackRevisionKey(
  pullRequests: ReadonlyArray<Pick<SignalPullRequest, "id" | "headSha">>,
): string {
  return [...pullRequests]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((pr) => `${pr.id}:${pr.headSha ?? "none"}`)
    .join("|")
}

export function summarizeStackSignals(input: {
  readonly pullRequests: ReadonlyArray<SignalPullRequest>
  readonly checks: ReadonlyArray<CheckRow>
  readonly reviews: ReadonlyArray<ReviewRow>
  readonly deployments: ReadonlyArray<DeploymentRow>
}): StackSignals {
  const currentChecks = input.pullRequests.flatMap((pr) => {
    const forPr = input.checks.filter(
      (check) =>
        check.prId === pr.id &&
        check.headSha === pr.headSha &&
        !ignoredStates.has(normalizeState(check.state)),
    )
    // Check runs are canonical; commit statuses are the fallback for CI
    // systems that only report statuses.
    const runs = forPr.filter((check) => check.source === "check_run")
    return latestByName(runs.length > 0 ? runs : forPr)
  })
  const failures = currentChecks
    .filter((check) => failureStates.has(normalizeState(check.state)))
    .map((check) => ({ name: check.name.trim() || "CI", url: check.url }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const passing = currentChecks.filter((check) =>
    passingStates.has(normalizeState(check.state)),
  ).length
  const pending = currentChecks.length - passing - failures.length

  const reviewerStates = new Map<
    number,
    { id: number; login: string; state: ReviewState; updatedAt: number }
  >()
  for (const pr of input.pullRequests) {
    for (const reviewer of pr.reviewers) {
      reviewerStates.set(reviewer.id, {
        ...reviewer,
        state: "waiting",
        updatedAt: 0,
      })
    }
  }
  const prIds = new Set(input.pullRequests.map((pr) => pr.id))
  const stackReviews = input.reviews.filter((review) => prIds.has(review.prId))
  for (const review of stackReviews) {
    const existing = reviewerStates.get(review.reviewerId)
    if (existing !== undefined && existing.updatedAt > review.updatedAt) {
      continue
    }
    reviewerStates.set(review.reviewerId, {
      id: review.reviewerId,
      login: review.login,
      state: review.state,
      updatedAt: review.updatedAt,
    })
  }

  const reviewerTeams = [
    ...new Map(
      input.pullRequests
        .flatMap((pr) => pr.reviewerTeams)
        .map((team) => [team.id, team]),
    ).values(),
  ]

  const approvedPullRequestIds = input.pullRequests
    .filter((pr) => pullRequestApproved(pr, stackReviews))
    .map((pr) => pr.id)

  return {
    build: { passing, failing: failures.length, pending, failures },
    reviewers: [...reviewerStates.values()]
      .map(({ id, login, state }) => ({ id, login, state }))
      .sort((left, right) => left.login.localeCompare(right.login)),
    reviewerTeams,
    approvedPullRequestIds,
    deployment: latestDeployment(input.pullRequests, input.deployments),
  }
}

export function emptyStackSignals(): StackSignals {
  return {
    build: { passing: 0, failing: 0, pending: 0, failures: [] },
    reviewers: [],
    reviewerTeams: [],
    approvedPullRequestIds: [],
    deployment: null,
  }
}

function pullRequestApproved(
  pr: SignalPullRequest,
  reviews: ReadonlyArray<ReviewRow>,
): boolean {
  if (pr.reviewerTeams.length > 0) return false
  const states = new Map<number, ReviewState>(
    pr.reviewers.map((reviewer) => [reviewer.id, "waiting"]),
  )
  // Reviews are stored latest-per-reviewer, and a re-request clears the
  // reviewer's stored review, so a stored review always outranks the request.
  for (const review of reviews) {
    if (review.prId === pr.id) states.set(review.reviewerId, review.state)
  }
  return (
    states.size > 0 &&
    [...states.values()].every((state) => state === "approved")
  )
}

function latestDeployment(
  pullRequests: ReadonlyArray<SignalPullRequest>,
  deployments: ReadonlyArray<DeploymentRow>,
): StackSignals["deployment"] {
  const current = deployments
    .filter((deployment) =>
      pullRequests.some(
        (pr) => pr.id === deployment.prId && pr.headSha === deployment.headSha,
      ),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  if (current === undefined) return null
  const state = normalizeState(current.state)
  if (passingStates.has(state)) return "ready"
  if (failureStates.has(state)) return "failing"
  if (ignoredStates.has(state) || state === "inactive") return null
  return "deploying"
}

function latestByName(
  checks: ReadonlyArray<CheckRow>,
): ReadonlyArray<CheckRow> {
  const latest = new Map<string, CheckRow>()
  for (const check of checks) {
    const key = check.name.trim().toLowerCase() || "ci"
    const existing = latest.get(key)
    if (existing === undefined || existing.updatedAt <= check.updatedAt) {
      latest.set(key, check)
    }
  }
  return [...latest.values()]
}

export function isGraphiteMergeQueueComment(body: string | null): boolean {
  const value = body ?? ""
  return (
    /(?:^|\n)#{1,6}\s+merge activity\b/i.test(value) &&
    /started a stack merge that includes this pull request via \[?graphite\]?/i.test(
      value,
    )
  )
}

export const SLACK_ECHO_MARKER = "<!-- stackping:slack:"

/** Comments stackping itself created from Slack replies. */
export function isSlackEcho(body: string | null): boolean {
  return (body ?? "").includes(SLACK_ECHO_MARKER)
}

export function isAutomatedActor(login: string | null): boolean {
  const normalized = login?.trim().toLowerCase() ?? ""
  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("-bot") ||
    normalized === "github-actions"
  )
}

/** Graphite's boilerplate, which Graphite can post through a human account. */
export function isAutomatedComment(body: string | null): boolean {
  const value = body ?? ""
  return [
    /(?:^|\n)#{1,6}\s+graphite automations\b/i,
    /(?:^|\n)#{1,6}\s+how to use the graphite merge queue\b/i,
    /this pull request is not mergeable via github because (?:a )?downstack pr is open/i,
    /once all requirements are satisfied,? merge this pr as a stack/i,
    /this stack of pull requests is managed by \[?graphite\]?/i,
    /an organization admin has enabled the \[?graphite merge queue\]?/i,
    /(?:utm_source|utm-source)=stack-comment(?:-icon)?/i,
    /<!--\s*current dependencies on\/for this pr:\s*-->/i,
  ].some((pattern) => pattern.test(value))
}

function normalizeState(state: string | null): string {
  return state?.trim().toLowerCase() || "pending"
}
