import { describe, expect, it } from "bun:test"

import {
  checkRunEvent,
  commentEvent,
  makeHarness,
  prEvent,
  reviewEvent,
} from "../support.ts"

async function postedStack() {
  const h = makeHarness()
  h.deliver(
    "pull_request",
    prEvent({ number: 1, head: "feat-a", reviewers: ["hubot"] }, h.clock),
  )
  await h.settle()
  const rootTs = [...h.slack.messages.keys()][0]!
  h.slack.reset()
  return { h, rootTs }
}

function threadTexts(
  h: ReturnType<typeof makeHarness>,
  rootTs: string,
): string[] {
  return [...h.slack.messages.values()]
    .filter((message) => message.threadTs === rootTs)
    .map((message) => message.text)
}

function rootText(h: ReturnType<typeof makeHarness>, rootTs: string): string {
  return h.slack.messages.get(rootTs)!.text
}

describe("thread replies", () => {
  it("posts human comments as the commenter and quotes the body", async () => {
    const { h, rootTs } = await postedStack()
    h.slack.profiles.set("U0HUBOT00", {
      display_name: "Hubot",
      image_192: "https://slack.example/hubot.png",
    })
    h.deliver(
      "issue_comment",
      commentEvent({ number: 1, id: 10, body: "Looks <good> & fine" }),
    )
    await h.settle()
    const post = h.slack.posts()[0]!
    expect(post.body.thread_ts).toBe(rootTs)
    expect(post.body.username).toBe("Hubot")
    expect(post.body.icon_url).toBe("https://slack.example/hubot.png")
    expect(post.body.text).toBe(
      ":speech_balloon: commented on <https://app.graphite.com/github/pr/acme/web/1|#1>\n> Looks &lt;good&gt; &amp; fine",
    )
  })

  it("drops bots, Graphite boilerplate, and stackping's own Slack echoes", async () => {
    const { h } = await postedStack()
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 11,
        body: "Deployed!",
        author: "github-actions[bot]",
      }),
    )
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 12,
        body: "This stack of pull requests is managed by [Graphite](https://graphite.dev).",
        author: "octocat",
      }),
    )
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 13,
        body: "**octocat** replied in Slack:\n\nhi\n\n<!-- stackping:slack:C1:1.2 -->",
        author: "octocat",
      }),
    )
    await h.settle()
    expect(h.slack.writes()).toHaveLength(0)
  })

  it("keeps the merge-queue notice but hides its boilerplate", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 14,
        author: "graphite-app[bot]",
        body: "### Merge activity\n* **Oct 14**: A user started a stack merge that includes this pull request via [Graphite](https://app.graphite.com).",
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toEqual([
      ":large_purple_circle: Added <https://app.graphite.com/github/pr/acme/web/1|#1> to the merge queue",
    ])
  })

  it("edits replies in place and tombstones deleted comments", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "issue_comment",
      commentEvent({ number: 1, id: 20, body: "first" }),
    )
    await h.settle()
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 20,
        body: "second",
        action: "edited",
        updatedAt: h.clock.now + 1_000,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toEqual([
      ":speech_balloon: commented on <https://app.graphite.com/github/pr/acme/web/1|#1> (edited)\n> second",
    ])
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 20,
        body: "second",
        action: "deleted",
        updatedAt: h.clock.now + 2_000,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toEqual([
      ":wastebasket: Comment was deleted on <https://app.graphite.com/github/pr/acme/web/1|#1>",
    ])
  })

  it("deletes a reply when a comment is edited into boilerplate", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "issue_comment",
      commentEvent({ number: 1, id: 21, body: "real", author: "octocat" }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toHaveLength(1)
    h.deliver(
      "issue_comment",
      commentEvent({
        number: 1,
        id: 21,
        author: "octocat",
        action: "edited",
        updatedAt: h.clock.now + 1_000,
        body: "This stack of pull requests is managed by Graphite",
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toHaveLength(0)
  })
})

describe("reviews", () => {
  it("marks approvals in the thread and the root", async () => {
    const { h, rootTs } = await postedStack()
    h.advance(1_000)
    h.deliver(
      "pull_request",
      prEvent(
        {
          number: 1,
          head: "feat-a",
          action: "review_request_removed",
          reviewers: [],
        },
        h.clock,
      ),
    )
    h.deliver(
      "pull_request_review",
      reviewEvent({
        number: 1,
        id: 30,
        state: "approved",
        submittedAt: h.clock.now,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toContain(
      ":large_green_circle: approved <https://app.graphite.com/github/pr/acme/web/1|#1>",
    )
    expect(rootText(h, rootTs)).toContain(":white_check_mark: *<")
    expect(rootText(h, rootTs)).toContain("#1 APPROVED")
    expect(rootText(h, rootTs)).toContain("┃ `REVIEW` ┃ <@U0HUBOT00> ✓")
  })

  it("pings the author on requested changes and ignores empty comment reviews", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "pull_request_review",
      reviewEvent({
        number: 1,
        id: 31,
        state: "commented",
        body: "",
        submittedAt: h.clock.now,
      }),
    )
    h.deliver(
      "pull_request_review",
      reviewEvent({
        number: 1,
        id: 32,
        state: "changes_requested",
        body: "Please fix",
        submittedAt: h.clock.now + 1,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toEqual([
      ":red_circle: requested changes on <https://app.graphite.com/github/pr/acme/web/1|#1>\n> Please fix\nAuthor: <@U0OCTOCAT>",
    ])
    expect(rootText(h, rootTs)).toContain("<@U0HUBOT00> ✕")
  })

  it("labels repeated review requests and approvals", async () => {
    const { h, rootTs } = await postedStack()
    const request = (at: number) =>
      h.deliver(
        "pull_request",
        prEvent(
          {
            number: 1,
            head: "feat-a",
            action: "review_requested",
            reviewers: ["monalisa"],
            requestedReviewer: "monalisa",
            updatedAt: at,
          },
          h.clock,
        ),
      )
    request(h.clock.now + 1_000)
    await h.settle()
    request(h.clock.now + 60_000)
    await h.settle()
    h.deliver(
      "pull_request_review",
      reviewEvent({
        number: 1,
        id: 40,
        state: "approved",
        author: "monalisa",
        submittedAt: h.clock.now + 61_000,
      }),
    )
    h.deliver(
      "pull_request_review",
      reviewEvent({
        number: 1,
        id: 41,
        state: "approved",
        author: "monalisa",
        submittedAt: h.clock.now + 62_000,
      }),
    )
    await h.settle()
    const link = "<https://app.graphite.com/github/pr/acme/web/1|#1>"
    expect(threadTexts(h, rootTs)).toEqual([
      `:eyes: Review requested from <@U0MONALIS> on ${link}`,
      `:eyes: Review re-requested from <@U0MONALIS> on ${link}`,
      `:large_green_circle: approved ${link}`,
      `:large_green_circle: re-approved ${link}`,
    ])
  })

  it("removes the ping when a review request is withdrawn", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "pull_request",
      prEvent(
        {
          number: 1,
          head: "feat-a",
          action: "review_requested",
          reviewers: ["hubot", "monalisa"],
          requestedReviewer: "monalisa",
          updatedAt: h.clock.now + 1_000,
        },
        h.clock,
      ),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toHaveLength(1)
    h.deliver(
      "pull_request",
      prEvent(
        {
          number: 1,
          head: "feat-a",
          action: "review_request_removed",
          reviewers: ["hubot"],
          requestedReviewer: "monalisa",
          updatedAt: h.clock.now + 2_000,
        },
        h.clock,
      ),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toHaveLength(0)
  })
})

describe("CI", () => {
  it("posts one failure summary per revision and updates it when CI recovers", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "check_run",
      checkRunEvent({
        id: 1,
        name: "test",
        sha: "sha-1",
        numbers: [1],
        conclusion: "failure",
        at: h.clock.now,
      }),
    )
    h.deliver(
      "check_run",
      checkRunEvent({
        id: 2,
        name: "lint",
        sha: "sha-1",
        numbers: [1],
        conclusion: "success",
        at: h.clock.now,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toEqual([
      ":rotating_light: *Build broken · 1 check* on <https://app.graphite.com/github/pr/acme/web/1|#1>\n• <https://github.com/acme/web/runs/1|test>",
    ])
    expect(rootText(h, rootTs)).toContain("┃ `CHECKS` ┃ 1 Failing · 1 Passing")

    h.deliver(
      "check_run",
      checkRunEvent({
        id: 3,
        name: "test",
        sha: "sha-1",
        numbers: [1],
        conclusion: "success",
        at: h.clock.now + 1,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toEqual([
      ":white_check_mark: *Build passing · 2 / 2 checks* on <https://app.graphite.com/github/pr/acme/web/1|#1>",
    ])
    expect(rootText(h, rootTs)).toContain("┃ `CHECKS` ┃ 2 / 2 Passing")
  })

  it("stays quiet while CI passes and ignores skipped checks", async () => {
    const { h, rootTs } = await postedStack()
    h.deliver(
      "check_run",
      checkRunEvent({
        id: 4,
        name: "build",
        sha: "sha-1",
        numbers: [1],
        conclusion: "success",
        at: h.clock.now,
      }),
    )
    h.deliver(
      "check_run",
      checkRunEvent({
        id: 5,
        name: "deploy",
        sha: "sha-1",
        numbers: [1],
        conclusion: "skipped",
        at: h.clock.now,
      }),
    )
    await h.settle()
    expect(threadTexts(h, rootTs)).toHaveLength(0)
    expect(rootText(h, rootTs)).toContain("┃ `CHECKS` ┃ 1 / 1 Passing")
  })

  it("batches a burst of check events into one root update", async () => {
    const { h } = await postedStack()
    for (let id = 100; id < 130; id += 1) {
      h.deliver(
        "check_run",
        checkRunEvent({
          id,
          name: `job-${id}`,
          sha: "sha-1",
          numbers: [1],
          conclusion: "success",
          at: h.clock.now,
        }),
      )
      h.advance(50)
    }
    await h.settle()
    expect(
      h.slack.calls.filter((call) => call.method === "chat.update"),
    ).toHaveLength(1)
  })
})
