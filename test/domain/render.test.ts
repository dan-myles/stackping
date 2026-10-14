import { describe, expect, it } from "bun:test"

import type { PullRequestView, StackView } from "../../src/domain/view.ts"

import {
  renderCiSummary,
  renderStackMessage,
  renderThreadItem,
} from "../../src/destinations/slack/render.ts"
import { emptyStackSignals } from "../../src/domain/signals.ts"

const url = "https://app.graphite.com/github/pr/acme/web/42"
const pr: PullRequestView = {
  id: "1:42",
  parentId: null,
  repositoryFullName: "acme/web",
  number: 42,
  title: "feat: add widgets",
  url,
  headRef: "feat/widgets",
  baseRef: "main",
  status: "open",
  authorId: 1,
  authorLogin: "octocat",
  authorAvatarUrl: null,
  additions: 184,
  deletions: 27,
  changedFiles: 8,
  commitCount: 3,
}
const users = { octocat: "U0OCTOCAT", hubot: "U0HUBOT00" }

function stack(overrides: Partial<StackView> = {}): StackView {
  return {
    root: pr,
    members: [pr],
    signals: {
      ...emptyStackSignals(),
      build: { passing: 12, failing: 0, pending: 0, failures: [] },
      reviewers: [{ id: 2, login: "hubot", state: "waiting" }],
      deployment: "ready",
    },
    users,
    ...overrides,
  }
}

describe("Slack rendering", () => {
  it("renders a linked header and the signal rail", () => {
    expect(renderStackMessage(stack())).toBe(
      [
        `🟡 *<${url}|#42 OPEN · feat: add widgets>*`,
        "`web`  `feat/widgets` → `main`",
        "",
        "┃ `CHECKS` ┃ 12 / 12 Passing",
        "┃ `CHANGE` ┃ +184 −27 · 8 files · 3 commits",
        "┃ `REVIEW` ┃ <@U0HUBOT00> ○",
        "┃ `DEPLOY` ┃ Production ready",
      ].join("\n"),
    )
  })

  it("distinguishes approved, merged, and closed", () => {
    const approved = renderStackMessage(
      stack({
        signals: {
          ...stack().signals,
          reviewers: [{ id: 2, login: "hubot", state: "approved" }],
          approvedPullRequestIds: [pr.id],
        },
      }),
    )
    expect(approved).toContain(`:white_check_mark: *<${url}|#42 APPROVED · `)
    expect(approved).toContain("<@U0HUBOT00> ✓")

    const merged = { ...pr, status: "merged" as const }
    expect(
      renderStackMessage(stack({ root: merged, members: [merged] })),
    ).toContain(`:ballot_box_with_check: *<${url}|#42 MERGED · `)
    const closed = { ...pr, status: "closed" as const }
    expect(
      renderStackMessage(stack({ root: closed, members: [closed] })),
    ).toContain(`:black_circle: *<${url}|#42 CLOSED · `)
  })

  it("renders a stack as a tree in one message", () => {
    const child: PullRequestView = {
      ...pr,
      id: "1:43",
      parentId: pr.id,
      number: 43,
      title: "feat: price widgets",
      url: `${url.slice(0, -2)}43`,
      headRef: "feat/price",
      baseRef: "feat/widgets",
    }
    const text = renderStackMessage(stack({ members: [pr, child] }))
    expect(text).toContain(":pancakes: *2 PR STACK*  `web` → `main`")
    expect(text).toContain(`\n└─ 🟡 *<${url}|#42 OPEN · feat: add widgets>*`)
    expect(text).toContain(
      "\n\u00a0\u00a0\u00a0└─ 🟡 *<https://app.graphite.com/github/pr/acme/web/43|#43 OPEN",
    )
    expect(text).toContain("┃ `CHANGE` ┃ +368 −54 · 16 files · 6 commits")
  })

  it("truncates huge stacks within Slack's limits", () => {
    const members = Array.from({ length: 25 }, (_, index) => ({
      ...pr,
      id: `1:${index}`,
      parentId: index === 0 ? null : `1:${index - 1}`,
      number: index,
      title: "x".repeat(250),
    }))
    const text = renderStackMessage(stack({ root: members[0]!, members }))
    expect(text.length).toBeLessThan(4_000)
    expect(text).toContain("25 PR STACK")
  })

  it("escapes markup and keeps unmapped people readable", () => {
    const text = renderStackMessage(
      stack({
        root: { ...pr, title: "fix: keep <tags> & | pipes" },
        members: [{ ...pr, title: "fix: keep <tags> & | pipes" }],
        signals: {
          ...stack().signals,
          reviewers: [{ id: 9, login: "stranger", state: "waiting" }],
        },
      }),
    )
    expect(text).toContain("fix: keep &lt;tags&gt; &amp; │ pipes")
    expect(text).toContain("@stranger ○")
  })

  it("renders CI summaries", () => {
    const root = { number: 42, url }
    expect(
      renderCiSummary({
        root,
        build: {
          passing: 3,
          failing: 1,
          pending: 0,
          failures: [{ name: "test", url: "https://ci/1" }],
        },
      }),
    ).toBe(
      `:rotating_light: *Build broken · 1 check* on <${url}|#42>\n• <https://ci/1|test>`,
    )
    expect(
      renderCiSummary({
        root,
        build: { passing: 3, failing: 0, pending: 1, failures: [] },
      }),
    ).toBe(
      `:large_yellow_circle: *Build running · 3 / 4 checks passing* on <${url}|#42>`,
    )
  })

  it("renders review-thread and review-comment items", () => {
    const base = {
      kind: "review_comment" as const,
      action: "created",
      actorLogin: "hubot",
      actorAvatarUrl: null,
      body: "nit",
      url: null,
      state: null,
      path: "src/a.ts",
      line: 12,
      targetName: null,
      targetId: null,
      deleted: false,
      edited: false,
      reviewNotificationKind: null,
      pullRequest: {
        number: 42,
        url,
        authorLogin: "octocat",
        reviewers: [],
        reviewerTeams: [],
      },
      users,
    }
    expect(renderThreadItem(base)).toBe(
      `:mag: left a review comment on src/a.ts:12 in <${url}|#42>\n> nit`,
    )
    expect(
      renderThreadItem({
        ...base,
        kind: "review_thread",
        state: "resolved",
        body: null,
      }),
    ).toBe(`:white_check_mark: resolved a review thread on <${url}|#42>`)
  })
})
