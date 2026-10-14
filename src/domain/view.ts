import type { PullRequestStatus, ThreadItemKind } from "./github.ts"
import type { ReviewNotificationKind } from "./reviewHistory.ts"
import type { BuildSignal, StackSignals } from "./signals.ts"

/**
 * Destination-agnostic view models. The engine builds these from stored state;
 * each destination (Slack today) turns them into its own message format.
 */

export interface PullRequestView {
  readonly id: string
  readonly parentId: string | null
  readonly repositoryFullName: string
  readonly number: number
  readonly title: string
  /** Where titles link: Graphite or GitHub, per config. */
  readonly url: string
  readonly headRef: string
  readonly baseRef: string
  readonly status: PullRequestStatus
  readonly authorId: number
  readonly authorLogin: string
  readonly authorAvatarUrl: string | null
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly commitCount: number
}

/** GitHub login (lowercase) → destination user ID, for mentions. */
export type UserDirectory = Readonly<Record<string, string>>

export interface StackView {
  readonly root: PullRequestView
  /** Every PR in the stack, including the root. */
  readonly members: ReadonlyArray<PullRequestView>
  readonly signals: StackSignals
  readonly users: UserDirectory
}

export interface ThreadItemView {
  readonly kind: ThreadItemKind
  readonly action: string
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
  readonly reviewNotificationKind: ReviewNotificationKind | null
  readonly pullRequest: {
    readonly number: number
    readonly url: string
    readonly authorLogin: string
    readonly reviewers: ReadonlyArray<{ readonly login: string }>
    readonly reviewerTeams: ReadonlyArray<{ readonly slug: string }>
  }
  readonly users: UserDirectory
}

export interface CiSummaryView {
  readonly root: Pick<PullRequestView, "number" | "url">
  readonly build: BuildSignal
}

/** A pointer to a message a destination posted. */
export interface MessageRef {
  readonly channel: string
  readonly ts: string
}
