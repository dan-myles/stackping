import { describe, expect, it } from "bun:test"

import { CHANNEL, makeHarness, prEvent } from "../support.ts"

describe("stack messages", () => {
  it("posts one root message after the settle window", async () => {
    const h = makeHarness()
    expect(
      h.deliver(
        "pull_request",
        prEvent({ number: 1, head: "feat-a" }, h.clock),
      ),
    ).toEqual({
      status: "processed",
    })
    expect(h.slack.posts()).toHaveLength(0)

    await h.settle()
    const posts = h.slack.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.channel).toBe(CHANNEL)
    expect(String(posts[0]!.body.text)).toContain("#1 OPEN · PR 1")
    expect(String(posts[0]!.body.text)).toContain(
      "https://app.graphite.com/github/pr/acme/web/1",
    )
  })

  it("collapses a gt submit --stack burst into one message, in any order", async () => {
    const h = makeHarness()
    // Children arrive before their parents.
    h.deliver(
      "pull_request",
      prEvent({ number: 3, head: "feat-c", base: "feat-b" }, h.clock),
    )
    h.advance(300)
    h.deliver(
      "pull_request",
      prEvent({ number: 2, head: "feat-b", base: "feat-a" }, h.clock),
    )
    h.advance(300)
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()

    const posts = h.slack.posts()
    expect(posts).toHaveLength(1)
    const text = String(posts[0]!.body.text)
    expect(text).toContain(":pancakes: *3 PR STACK*  `web` → `main`")
    expect(text.indexOf("#1 OPEN")).toBeLessThan(text.indexOf("#2 OPEN"))
    expect(text.indexOf("#2 OPEN")).toBeLessThan(text.indexOf("#3 OPEN"))
  })

  it("folds a child's standalone message into its parent's stack", async () => {
    const h = makeHarness()
    h.deliver(
      "pull_request",
      prEvent({ number: 2, head: "feat-b", base: "feat-a" }, h.clock),
    )
    await h.settle()
    expect(h.slack.posts()).toHaveLength(1)
    const orphanTs = [...h.slack.messages.keys()][0]!

    h.advance(60_000)
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()

    expect(h.slack.messages.has(orphanTs)).toBe(false)
    const remaining = [...h.slack.messages.values()]
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.text).toContain("2 PR STACK")
  })

  it("does not post drafts until they are ready for review", async () => {
    const h = makeHarness()
    h.deliver(
      "pull_request",
      prEvent({ number: 1, head: "feat-a", draft: true }, h.clock),
    )
    await h.settle()
    expect(h.slack.posts()).toHaveLength(0)

    h.advance(1_000)
    h.deliver(
      "pull_request",
      prEvent(
        {
          number: 1,
          head: "feat-a",
          action: "ready_for_review",
          reviewers: ["hubot"],
        },
        h.clock,
      ),
    )
    await h.settle()
    const posts = h.slack.posts()
    expect(posts).toHaveLength(2)
    expect(String(posts[0]!.body.text)).toContain("#1 OPEN")
    expect(posts[1]!.body.thread_ts).toBe(
      [...h.slack.messages.entries()].find(([, m]) => !m.threadTs)![0],
    )
    expect(String(posts[1]!.body.text)).toBe(
      ":eyes: <https://app.graphite.com/github/pr/acme/web/1|#1> is ready for review\nReviewers: <@U0HUBOT00>",
    )
  })

  it("keeps updating a posted PR that goes back to draft", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()
    h.advance(1_000)
    h.deliver(
      "pull_request",
      prEvent(
        {
          number: 1,
          head: "feat-a",
          action: "converted_to_draft",
          draft: true,
        },
        h.clock,
      ),
    )
    await h.settle()
    const updates = h.slack.calls.filter(
      (call) => call.method === "chat.update",
    )
    expect(updates).toHaveLength(1)
    expect(String(updates[0]!.body.text)).toContain("⚪ *<")
    expect(String(updates[0]!.body.text)).toContain("#1 DRAFT")
  })

  it("ignores duplicate deliveries and stale events", async () => {
    const h = makeHarness()
    const payload = prEvent(
      { number: 1, head: "feat-a", title: "New" },
      h.clock,
    )
    expect(h.deliver("pull_request", payload, "same")).toEqual({
      status: "processed",
    })
    expect(h.deliver("pull_request", payload, "same")).toEqual({
      status: "duplicate",
    })

    const older = prEvent(
      {
        number: 1,
        head: "feat-a",
        title: "Old",
        updatedAt: h.clock.now - 60_000,
      },
      h.clock,
    )
    expect(h.deliver("pull_request", older)).toEqual({
      status: "ignored",
      reason: "stale",
    })
    await h.settle()
    expect(String(h.slack.posts()[0]!.body.text)).toContain("New")
  })

  it("ignores repositories that are not configured", () => {
    const h = makeHarness()
    const payload = prEvent({ number: 1, head: "feat-a" }, h.clock)
    payload.repository.full_name = "someone/else"
    expect(h.deliver("pull_request", payload)).toEqual({
      status: "ignored",
      reason: "repository is not configured",
    })
  })

  it("makes no Slack call when nothing visible changed", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()
    h.slack.reset()
    h.advance(1_000)
    h.deliver(
      "pull_request",
      prEvent({ number: 1, head: "feat-a", action: "labeled" }, h.clock),
    )
    await h.settle()
    expect(h.slack.writes()).toHaveLength(0)
  })

  it("keeps trunk promotions out of feature stacks", async () => {
    const h = makeHarness({
      config: { repos: [{ repo: "acme/web", trunks: ["develop"] }] },
    })
    h.deliver(
      "pull_request",
      prEvent({ number: 1, head: "develop", base: "main" }, h.clock),
    )
    h.deliver(
      "pull_request",
      prEvent({ number: 2, head: "feat-a", base: "develop" }, h.clock),
    )
    await h.settle()
    const posts = h.slack.posts()
    expect(posts).toHaveLength(2)
    expect(
      posts.every((post) => !String(post.body.text).includes("STACK")),
    ).toBe(true)
  })

  it("hands the stack message to the next PR when the bottom merges", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    h.deliver(
      "pull_request",
      prEvent({ number: 2, head: "feat-b", base: "feat-a" }, h.clock),
    )
    await h.settle()
    expect(h.slack.posts()).toHaveLength(1)
    const rootTs = [...h.slack.messages.entries()].find(
      ([, m]) => !m.threadTs,
    )![0]

    h.advance(60_000)
    h.deliver(
      "pull_request",
      prEvent(
        {
          number: 1,
          head: "feat-a",
          action: "closed",
          state: "closed",
          merged: true,
        },
        h.clock,
      ),
    )
    h.advance(500)
    h.deliver(
      "pull_request",
      prEvent(
        { number: 2, head: "feat-b", base: "main", action: "edited" },
        h.clock,
      ),
    )
    await h.settle()

    const roots = [...h.slack.messages.entries()].filter(([, m]) => !m.threadTs)
    expect(roots).toHaveLength(1)
    expect(roots[0]![0]).toBe(rootTs)
    expect(roots[0]![1].text).toContain("#2 OPEN")
    expect(roots[0]![1].text).not.toContain("STACK")
    const thread = [...h.slack.messages.values()].filter(
      (m) => m.threadTs === rootTs,
    )
    expect(thread.map((m) => m.text)).toContain(
      ":ballot_box_with_check: merged <https://app.graphite.com/github/pr/acme/web/1|#1>",
    )
  })

  it("shows closed PRs with a neutral circle", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()
    h.advance(1_000)
    h.deliver(
      "pull_request",
      prEvent(
        { number: 1, head: "feat-a", action: "closed", state: "closed" },
        h.clock,
      ),
    )
    await h.settle()
    const root = [...h.slack.messages.values()][0]!
    expect(root.text).toContain(":black_circle: *<")
    expect(root.text).toContain("#1 CLOSED")
  })
})
