import type {
  CheckInput,
  GitHubTeam,
  GitHubUser,
  PullRequestSnapshot,
  PullRequestStatus,
} from "../domain/github.ts"
import type { ReviewState } from "../domain/signals.ts"

import { reviewStateFor } from "../domain/signals.ts"

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class GitHubError extends Error {
  override readonly name = "GitHubError"
  readonly status: number
  readonly retryable: boolean
  readonly retryAfterMs: number | null

  constructor(options: {
    readonly status: number
    readonly message: string
    readonly retryable: boolean
    readonly retryAfterMs?: number | null
  }) {
    super(options.message)
    this.status = options.status
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs ?? null
  }

  get notFound(): boolean {
    return this.status === 404 || this.status === 410
  }
}

export interface ReconciledReview {
  readonly reviewerId: number
  readonly login: string
  readonly state: ReviewState
  readonly updatedAt: number
}

export interface ReconciledPullRequest {
  readonly snapshot: PullRequestSnapshot
  readonly checks: ReadonlyArray<CheckInput>
  readonly reviews: ReadonlyArray<ReconciledReview>
}

export interface GitHubClientOptions {
  readonly token: string
  readonly fetch?: Fetch
  readonly baseUrl?: string
}

export class GitHubClient {
  readonly #token: string
  readonly #fetch: Fetch
  readonly #baseUrl: string

  constructor(options: GitHubClientOptions) {
    this.#token = options.token
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#baseUrl = options.baseUrl ?? "https://api.github.com"
  }

  async createIssueComment(
    repositoryFullName: string,
    number: number,
    body: string,
  ): Promise<{ id: number; url: string }> {
    const response = await this.#request(
      "POST",
      `/repos/${repositoryFullName}/issues/${number}/comments`,
      { body },
    )
    return { id: Number(response.id), url: String(response.html_url ?? "") }
  }

  async updateIssueComment(
    repositoryFullName: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.#request(
      "PATCH",
      `/repos/${repositoryFullName}/issues/comments/${commentId}`,
      { body },
    )
  }

  async deleteIssueComment(
    repositoryFullName: string,
    commentId: number,
  ): Promise<void> {
    await this.#request(
      "DELETE",
      `/repos/${repositoryFullName}/issues/comments/${commentId}`,
    )
  }

  /**
   * One GraphQL request per repository: open PRs with reviews and checks, plus
   * recently closed PRs so a missed `closed` webhook still lands.
   */
  async reconcileRepository(repositoryFullName: string): Promise<{
    readonly repositoryId: number
    readonly defaultBranch: string | null
    readonly pullRequests: ReadonlyArray<ReconciledPullRequest>
  }> {
    const [owner, name] = repositoryFullName.split("/")
    const data = await this.#graphql(RECONCILE_QUERY, { owner, name })
    const repository = record(data.repository)
    if (repository === null) {
      throw new GitHubError({
        status: 404,
        message: `GitHub repository ${repositoryFullName} was not found`,
        retryable: false,
      })
    }
    const repositoryId = Number(repository.databaseId)
    const defaultBranch =
      stringField(record(repository.defaultBranchRef) ?? {}, "name") ?? null
    const nodes = [
      ...array(record(repository.open)?.nodes),
      ...array(record(repository.closed)?.nodes),
    ]
    const pullRequests = nodes
      .map((node) =>
        toReconciled(node, {
          repositoryId,
          repositoryFullName:
            stringField(repository, "nameWithOwner") ?? repositoryFullName,
          defaultBranch,
        }),
      )
      .filter((pr): pr is ReconciledPullRequest => pr !== null)
    return { repositoryId, defaultBranch, pullRequests }
  }

  async #graphql(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#request("POST", "/graphql", {
      query,
      variables,
    })
    const errors = array(response.errors)
    if (errors.length > 0 && response.data == null) {
      const message = errors
        .map((error) => stringField(record(error) ?? {}, "message"))
        .filter(Boolean)
        .join("; ")
      throw new GitHubError({
        status: 200,
        message: `GitHub GraphQL error: ${message}`,
        retryable: false,
      })
    }
    return record(response.data) ?? {}
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "user-agent": "stackping",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new GitHubError({
        status: 0,
        message:
          error instanceof Error ? error.message : "GitHub request failed",
        retryable: true,
      })
    }

    if (response.status === 204) return {}
    const text = await response.text()
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") === "0")
      throw new GitHubError({
        status: response.status,
        message: `GitHub ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
        retryable:
          rateLimited || response.status === 408 || response.status >= 500,
        retryAfterMs:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1_000
            : rateLimited
              ? 60_000
              : null,
      })
    }
    try {
      return record(JSON.parse(text)) ?? {}
    } catch {
      return {}
    }
  }
}

const RECONCILE_QUERY = `
query StackpingReconcile($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    databaseId
    nameWithOwner
    defaultBranchRef { name }
    open: pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { ...StackpingPullRequest }
    }
    closed: pullRequests(states: [CLOSED, MERGED], first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { ...StackpingPullRequest }
    }
  }
}

fragment StackpingPullRequest on PullRequest {
  number
  title
  url
  state
  isDraft
  merged
  updatedAt
  additions
  deletions
  changedFiles
  commitCount: commits { totalCount }
  headRefName
  headRefOid
  baseRefName
  headRepository { databaseId }
  baseRepository { databaseId }
  author {
    login
    avatarUrl
    ... on User { databaseId }
    ... on Bot { databaseId }
  }
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { databaseId login avatarUrl }
        ... on Team { databaseId name slug }
      }
    }
  }
  latestReviews(first: 20) {
    nodes {
      state
      submittedAt
      author { login ... on User { databaseId } }
    }
  }
  lastCommit: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl startedAt completedAt title summary }
              ... on StatusContext { context state targetUrl description createdAt }
            }
          }
        }
      }
    }
  }
}
`

function toReconciled(
  value: unknown,
  repository: {
    readonly repositoryId: number
    readonly repositoryFullName: string
    readonly defaultBranch: string | null
  },
): ReconciledPullRequest | null {
  const node = record(value)
  if (node === null) return null
  const number = Number(node.number)
  const updatedAt = Date.parse(stringField(node, "updatedAt") ?? "")
  if (!Number.isFinite(number) || !Number.isFinite(updatedAt)) return null

  const state = stringField(node, "state")
  const status: PullRequestStatus =
    node.merged === true || state === "MERGED"
      ? "merged"
      : state === "CLOSED"
        ? "closed"
        : node.isDraft === true
          ? "draft"
          : "open"

  const author = record(node.author)
  const reviewers: GitHubUser[] = []
  const reviewerTeams: GitHubTeam[] = []
  for (const request of array(record(node.reviewRequests)?.nodes)) {
    const reviewer = record(record(request)?.requestedReviewer)
    if (reviewer === null) continue
    if (reviewer.__typename === "User") {
      reviewers.push({
        id: Number(reviewer.databaseId),
        login: stringField(reviewer, "login") ?? "",
        avatarUrl: stringField(reviewer, "avatarUrl"),
      })
    } else if (reviewer.__typename === "Team") {
      reviewerTeams.push({
        id: Number(reviewer.databaseId),
        name: stringField(reviewer, "name") ?? "",
        slug: stringField(reviewer, "slug") ?? "",
      })
    }
  }

  const headSha = stringField(node, "headRefOid")
  const snapshot: PullRequestSnapshot = {
    repositoryId: repository.repositoryId,
    repositoryFullName: repository.repositoryFullName,
    defaultBranch: repository.defaultBranch,
    number,
    title: stringField(node, "title") ?? "",
    url: stringField(node, "url") ?? "",
    author: {
      id: Number(author?.databaseId ?? 0),
      login: stringField(author ?? {}, "login") ?? "ghost",
      avatarUrl: stringField(author ?? {}, "avatarUrl"),
    },
    status,
    headRepositoryId: Number(record(node.headRepository)?.databaseId ?? -1),
    headRef: stringField(node, "headRefName") ?? "",
    headSha,
    baseRepositoryId: Number(
      record(node.baseRepository)?.databaseId ?? repository.repositoryId,
    ),
    baseRef: stringField(node, "baseRefName") ?? "",
    reviewers: reviewers.sort((left, right) => left.id - right.id),
    reviewerTeams: reviewerTeams.sort((left, right) => left.id - right.id),
    additions: Number(node.additions ?? 0),
    deletions: Number(node.deletions ?? 0),
    changedFiles: Number(node.changedFiles ?? 0),
    commitCount: Number(record(node.commitCount)?.totalCount ?? 0),
    githubUpdatedAt: updatedAt,
  }

  const reviews: ReconciledReview[] = []
  for (const review of array(record(node.latestReviews)?.nodes)) {
    const entry = record(review)
    const reviewer = record(entry?.author)
    const decisive = reviewStateFor(stringField(entry ?? {}, "state"))
    if (!entry || !reviewer || reviewer.databaseId == null || !decisive) {
      continue
    }
    reviews.push({
      reviewerId: Number(reviewer.databaseId),
      login: stringField(reviewer, "login") ?? "",
      state: decisive,
      updatedAt:
        Date.parse(stringField(entry, "submittedAt") ?? "") || updatedAt,
    })
  }

  const checks: CheckInput[] = []
  const commit = record(
    record(array(record(node.lastCommit)?.nodes)[0])?.commit,
  )
  const contexts = array(
    record(record(commit?.statusCheckRollup)?.contexts)?.nodes,
  )
  if (headSha) {
    for (const context of contexts) {
      const entry = record(context)
      if (entry === null) continue
      if (entry.__typename === "CheckRun") {
        const body = [
          stringField(entry, "title"),
          stringField(entry, "summary"),
        ]
          .filter(Boolean)
          .join("\n")
        checks.push({
          source: "check_run",
          name: stringField(entry, "name") ?? "CI",
          state: (
            stringField(entry, "conclusion") ??
            stringField(entry, "status") ??
            "pending"
          ).toLowerCase(),
          url: stringField(entry, "detailsUrl"),
          body: body || null,
          headSha,
          updatedAt:
            Date.parse(
              stringField(entry, "completedAt") ??
                stringField(entry, "startedAt") ??
                "",
            ) || updatedAt,
        })
      } else if (entry.__typename === "StatusContext") {
        checks.push({
          source: "status",
          name: stringField(entry, "context") ?? "CI",
          state: (stringField(entry, "state") ?? "pending").toLowerCase(),
          url: stringField(entry, "targetUrl"),
          body: stringField(entry, "description"),
          headSha,
          updatedAt:
            Date.parse(stringField(entry, "createdAt") ?? "") || updatedAt,
        })
      }
    }
  }

  return { snapshot, checks, reviews }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : []
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const field = value[key]
  return typeof field === "string" ? field : null
}
