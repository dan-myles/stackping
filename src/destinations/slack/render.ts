import type { PullRequestStatus } from "../../domain/github.ts"
import type { StackSignals } from "../../domain/signals.ts"
import type {
  CiSummaryView,
  PullRequestView,
  StackView,
  ThreadItemView,
  UserDirectory,
} from "../../domain/view.ts"

import { isGraphiteMergeQueueComment } from "../../domain/signals.ts"

export const MAX_QUOTE_LENGTH = 1_500
const STACK_TREE_BUDGET = 2_800

/** Prefix for stored render keys; bump it to force every message to re-render. */
export const RENDER_VERSION = "v1"

export function renderStackMessage(view: StackView): string {
  const approved = new Set(view.signals.approvedPullRequestIds)
  const header =
    view.members.length > 1
      ? renderStackHeader(view.root, view.members, approved)
      : renderSingleHeader(view.root, approved.has(view.root.id))
  return [header, "", renderSignalRail(view)].join("\n")
}

export function renderThreadItem(item: ThreadItemView): string {
  const prLink = `<${escapeSlack(item.pullRequest.url)}|#${item.pullRequest.number}>`
  if (item.deleted) {
    return `:wastebasket: ${itemLabel(item.kind)} was deleted on ${prLink}`
  }

  const lines = renderItemLines(item, prLink)
  if (item.edited) lines[0] = `${lines[0]} (edited)`

  const body = isGraphiteMergeQueueComment(item.body)
    ? null
    : excerpt(item.body, MAX_QUOTE_LENGTH)
  if (body !== null) {
    lines.push(...body.split("\n").map((line) => `> ${escapeSlack(line)}`))
  }

  if (item.kind === "review" && item.state === "changes_requested") {
    const author = item.users[item.pullRequest.authorLogin.toLowerCase()]
    if (author) lines.push(`Author: <@${author}>`)
  }

  return lines.join("\n")
}

export function renderCiSummary(view: CiSummaryView): string {
  const { build } = view
  const prLink = `<${escapeSlack(view.root.url)}|#${view.root.number}>`
  const total = build.passing + build.failing + build.pending

  if (build.failing > 0) {
    return [
      `:rotating_light: *Build broken · ${build.failing} ${build.failing === 1 ? "check" : "checks"}* on ${prLink}`,
      ...build.failures
        .slice(0, 8)
        .map((failure) =>
          failure.url
            ? `• <${escapeSlack(failure.url)}|${escapeSlack(failure.name)}>`
            : `• ${escapeSlack(failure.name)}`,
        ),
    ].join("\n")
  }
  if (build.pending > 0) {
    return `:large_yellow_circle: *Build running · ${build.passing} / ${total} checks passing* on ${prLink}`
  }
  return `:white_check_mark: *Build passing · ${build.passing} / ${total} checks* on ${prLink}`
}

/** Text for a root message whose PR was folded into another stack. */
export function renderMovedMessage(
  pr: Pick<PullRequestView, "number" | "url">,
  root: Pick<PullRequestView, "number" | "url">,
): string {
  return `:arrow_heading_down: <${escapeSlack(pr.url)}|#${pr.number}> is now part of the <${escapeSlack(root.url)}|#${root.number}> stack.`
}

function renderItemLines(item: ThreadItemView, prLink: string): string[] {
  switch (item.kind) {
    case "pull_request": {
      if (item.action === "ready_for_review") {
        const requested = [
          ...item.pullRequest.reviewers.map((reviewer) =>
            mention(reviewer.login, item.users),
          ),
          ...item.pullRequest.reviewerTeams.map(
            (team) => `@${escapeSlack(team.slug)}`,
          ),
        ]
        return [
          `:eyes: ${prLink} is ready for review`,
          ...(requested.length > 0
            ? [`Reviewers: ${summarize(requested, 6)}`]
            : []),
        ]
      }
      if (item.action === "review_requested") {
        const target =
          item.state === "user" && item.targetName
            ? mention(item.targetName, item.users)
            : item.targetName
              ? `@${escapeSlack(item.targetName)}`
              : "a reviewer"
        const verb =
          item.reviewNotificationKind === "rerequested"
            ? "re-requested"
            : "requested"
        return [`:eyes: Review ${verb} from ${target} on ${prLink}`]
      }
      if (item.state === "merged") {
        return [`:ballot_box_with_check: merged ${prLink}`]
      }
      return [`:speech_balloon: updated ${prLink}`]
    }
    case "comment":
      if (isGraphiteMergeQueueComment(item.body)) {
        return [`:large_purple_circle: Added ${prLink} to the merge queue`]
      }
      return [`:speech_balloon: commented on ${prLink}`]
    case "review_comment": {
      const location = item.path
        ? ` on ${escapeSlack(item.path)}${item.line === null ? "" : `:${item.line}`}`
        : ""
      return [`:mag: left a review comment${location} in ${prLink}`]
    }
    case "review": {
      if (item.state === "approved") {
        const verb =
          item.reviewNotificationKind === "reapproved"
            ? "re-approved"
            : "approved"
        return [`:large_green_circle: ${verb} ${prLink}`]
      }
      if (item.state === "changes_requested") {
        return [`:red_circle: requested changes on ${prLink}`]
      }
      if (item.state === "dismissed") {
        return [`:white_circle: review was dismissed on ${prLink}`]
      }
      return [`:speech_balloon: reviewed ${prLink}`]
    }
    case "review_thread":
      return item.state === "resolved"
        ? [`:white_check_mark: resolved a review thread on ${prLink}`]
        : [`:large_yellow_circle: reopened a review thread on ${prLink}`]
  }
}

function itemLabel(kind: ThreadItemView["kind"]): string {
  switch (kind) {
    case "pull_request":
      return "Pull request activity"
    case "comment":
      return "Comment"
    case "review":
      return "Review"
    case "review_comment":
      return "Review comment"
    case "review_thread":
      return "Review thread activity"
  }
}

function renderSingleHeader(pr: PullRequestView, approved: boolean): string {
  return [
    `${statusEmoji(pr.status, approved)} *<${escapeSlack(pr.url)}|#${pr.number} ${statusLabel(pr.status, approved)} · ${linkLabel(pr.title, 300)}>*`,
    `\`${escapeCode(repositoryName(pr.repositoryFullName))}\`  \`${escapeCode(pr.headRef)}\` → \`${escapeCode(pr.baseRef)}\``,
  ].join("\n")
}

function renderStackHeader(
  root: PullRequestView,
  members: ReadonlyArray<PullRequestView>,
  approved: ReadonlySet<string>,
): string {
  return [
    `:pancakes: *${members.length} PR STACK*  \`${escapeCode(repositoryName(root.repositoryFullName))}\` → \`${escapeCode(root.baseRef)}\``,
    renderStackTree(members, approved, STACK_TREE_BUDGET),
  ].join("\n")
}

function renderStackTree(
  members: ReadonlyArray<PullRequestView>,
  approved: ReadonlySet<string>,
  maximumLength: number,
): string {
  const byId = new Map(members.map((member) => [member.id, member]))
  const childrenByParent = new Map<string, PullRequestView[]>()
  for (const member of members) {
    const parentId =
      member.parentId && byId.has(member.parentId) ? member.parentId : "root"
    const children = childrenByParent.get(parentId) ?? []
    children.push(member)
    childrenByParent.set(parentId, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.number - right.number)
  }

  const rows: Array<{ prefix: string; member: PullRequestView }> = []
  const visit = (parentId: string, prefix: string) => {
    const children = childrenByParent.get(parentId) ?? []
    children.forEach((member, index) => {
      const last = index === children.length - 1
      rows.push({ prefix: `${prefix}${last ? "└─" : "├─"}`, member })
      visit(member.id, `${prefix}${last ? "   " : "│  "}`)
    })
  }
  visit("root", "")

  const rowStart = (prefix: string, member: PullRequestView) => {
    const isApproved = approved.has(member.id)
    return `${prefix} ${statusEmoji(member.status, isApproved)} *<${escapeSlack(member.url)}|#${member.number} ${statusLabel(member.status, isApproved)} · `
  }

  // Drop rows from the bottom until every visible title gets at least a few
  // characters within Slack's practical message length.
  for (let visibleCount = rows.length; visibleCount > 0; visibleCount -= 1) {
    const visible = rows.slice(0, visibleCount)
    const hidden = rows.length - visibleCount
    const summary = hidden > 0 ? `… +${hidden} more PRs` : null
    const fixedLength =
      visible.reduce(
        (total, { prefix, member }) =>
          total + rowStart(prefix, member).length + 2,
        0,
      ) +
      Math.max(0, visible.length - 1) +
      (summary === null ? 0 : summary.length + 1)
    const titleLength = Math.floor(
      (maximumLength - fixedLength) / visible.length,
    )

    if (titleLength >= 8 || visibleCount === 1) {
      return [
        ...visible.map(
          ({ prefix, member }) =>
            `${rowStart(prefix, member)}${linkLabel(member.title, Math.max(1, titleLength))}>*`,
        ),
        ...(summary === null ? [] : [summary]),
      ].join("\n")
    }
  }
  return ""
}

function renderSignalRail(view: StackView): string {
  const sum = (pick: (pr: PullRequestView) => number) =>
    view.members.reduce((total, pr) => total + pick(pr), 0)
  const additions = sum((pr) => pr.additions)
  const deletions = sum((pr) => pr.deletions)
  const files = sum((pr) => pr.changedFiles)
  const commits = sum((pr) => pr.commitCount)
  const changes = `+${formatNumber(additions)} −${formatNumber(deletions)} · ${formatNumber(files)} ${files === 1 ? "file" : "files"} · ${formatNumber(commits)} ${commits === 1 ? "commit" : "commits"}`

  const lines = [
    `┃ \`CHECKS\` ┃ ${renderBuildSignal(view.signals)}`,
    `┃ \`CHANGE\` ┃ ${changes}`,
    `┃ \`REVIEW\` ┃ ${renderReviewSignal(view.signals, view.users)}`,
  ]
  if (view.signals.deployment !== null) {
    lines.push(
      `┃ \`DEPLOY\` ┃ ${renderDeploymentSignal(view.signals.deployment)}`,
    )
  }
  return lines.join("\n")
}

function renderBuildSignal(signals: StackSignals): string {
  const { passing, failing, pending } = signals.build
  const total = passing + failing + pending
  if (total === 0) return "Waiting for checks"
  if (failing > 0) {
    return `${failing} Failing · ${passing} Passing${pending > 0 ? ` · ${pending} Running` : ""}`
  }
  if (pending > 0) return `${passing} / ${total} Passing · ${pending} Running`
  return `${passing} / ${total} Passing`
}

function renderReviewSignal(
  signals: StackSignals,
  users: UserDirectory,
): string {
  const people = signals.reviewers.map((reviewer) => {
    const who = mention(reviewer.login, users)
    switch (reviewer.state) {
      case "approved":
        return `${who} ✓`
      case "changes_requested":
        return `${who} ✕`
      case "waiting":
        return `${who} ○`
    }
  })
  const teams = signals.reviewerTeams.map(
    (team) => `@${escapeSlack(team.slug)} ○`,
  )
  const requested = [...people, ...teams]
  return requested.length > 0
    ? summarize(requested, 6)
    : "No reviewers requested"
}

function renderDeploymentSignal(
  deployment: NonNullable<StackSignals["deployment"]>,
): string {
  switch (deployment) {
    case "ready":
      return "Production ready"
    case "failing":
      return "Production failed"
    case "deploying":
      return "Production deploying"
  }
}

export function statusEmoji(
  status: PullRequestStatus,
  approved: boolean,
): string {
  switch (status) {
    case "merged":
      return ":ballot_box_with_check:"
    case "closed":
      return ":black_circle:"
    case "draft":
      return "⚪"
    case "open":
      return approved ? ":white_check_mark:" : "🟡"
  }
}

function statusLabel(status: PullRequestStatus, approved: boolean): string {
  return status === "open" && approved ? "APPROVED" : status.toUpperCase()
}

function mention(login: string, users: UserDirectory): string {
  const slackUserId = users[login.toLowerCase()]
  return slackUserId ? `<@${slackUserId}>` : `@${escapeSlack(login)}`
}

function summarize(values: ReadonlyArray<string>, maximum: number): string {
  const shown = values.slice(0, maximum)
  const remaining = values.length - shown.length
  return `${shown.join(", ")}${remaining > 0 ? ` +${remaining}` : ""}`
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

function repositoryName(fullName: string): string {
  return fullName.split("/").at(-1) ?? fullName
}

function excerpt(value: string | null, maximumLength: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.length <= maximumLength
    ? trimmed
    : `${trimmed.slice(0, maximumLength - 1).trimEnd()}…`
}

export function escapeSlack(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function escapeCode(value: string): string {
  return escapeSlack(value.replaceAll("`", "'"))
}

function linkLabel(value: string, maximumLength: number): string {
  const trimmed = value.trim().replaceAll(/\s+/g, " ")
  let escaped = ""
  for (const character of trimmed) {
    const next = character === "|" ? "│" : escapeSlack(character)
    if (escaped.length + next.length > maximumLength) {
      return `${escaped.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`
    }
    escaped += next
  }
  return escaped
}
