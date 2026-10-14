import type { ThreadItemKind } from "./github.ts"

export type ReviewNotificationKind =
  | "requested"
  | "rerequested"
  | "approved"
  | "reapproved"

export interface ReviewEvidence {
  readonly targetType: "user" | "team"
  readonly targetId: number
  readonly kind: "request" | "review"
  readonly hasApproved: boolean
}

/** What a thread item tells us about who was asked to review and who did. */
export function reviewEvidence(item: {
  readonly kind: ThreadItemKind
  readonly action: string
  readonly state: string | null
  readonly targetId: number | null
  readonly actorId: number | null
}): ReviewEvidence | null {
  if (
    item.kind === "pull_request" &&
    item.action === "review_requested" &&
    (item.state === "user" || item.state === "team") &&
    item.targetId !== null
  ) {
    return {
      targetType: item.state,
      targetId: item.targetId,
      kind: "request",
      hasApproved: false,
    }
  }
  const state = item.state?.toLowerCase() ?? ""
  if (
    item.kind === "review" &&
    item.actorId !== null &&
    ["approved", "changes_requested", "commented", "dismissed"].includes(state)
  ) {
    return {
      targetType: "user",
      targetId: item.actorId,
      kind: "review",
      hasApproved: state === "approved",
    }
  }
  return null
}

/**
 * Labels a request or approval as a repeat when the same reviewer was already
 * asked (or already approved) earlier on the same pull request.
 */
export function classifyReviewNotification(
  evidence: ReviewEvidence,
  occurredAt: number,
  history: ReadonlyArray<{
    readonly targetType: "user" | "team"
    readonly targetId: number
    readonly kind: "request" | "review"
    readonly hasApproved: boolean
    readonly occurredAt: number
  }>,
): ReviewNotificationKind | null {
  if (evidence.kind === "review" && !evidence.hasApproved) return null
  const prior = history.some(
    (entry) =>
      entry.targetType === evidence.targetType &&
      entry.targetId === evidence.targetId &&
      entry.occurredAt < occurredAt &&
      (evidence.kind === "request"
        ? entry.kind === "request"
        : entry.hasApproved),
  )
  if (evidence.kind === "request") return prior ? "rerequested" : "requested"
  return prior ? "reapproved" : "approved"
}
