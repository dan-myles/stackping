import { describe, expect, it } from "bun:test"

import {
  hmacSha256Hex,
  parseActivityEvent,
  parsePullRequestEvent,
  threadItemFromPullRequestEvent,
  verifyGitHubSignature,
} from "../../src/domain/github.ts"
import {
  parseSlackEnvelope,
  slackTextToGitHub,
  verifySlackSignature,
} from "../../src/destinations/slack/inbound.ts"
import { checkRunEvent, commentEvent, prEvent } from "../support.ts"

const clock = { now: Date.parse("2026-10-14T12:00:00Z") }

describe("GitHub payloads", () => {
  it("normalizes pull_request events", () => {
    const event = parsePullRequestEvent(
      prEvent(
        {
          number: 5,
          head: "feat-x",
          base: "feat-w",
          reviewers: ["hubot", "hubot"],
        },
        clock,
      ),
    )!
    expect(event.pullRequest).toMatchObject({
      number: 5,
      status: "open",
      headRef: "feat-x",
      baseRef: "feat-w",
      defaultBranch: "main",
      githubUpdatedAt: clock.now,
    })
    expect(event.pullRequest.reviewers).toHaveLength(1)
    expect(
      parsePullRequestEvent(
        prEvent({ number: 5, head: "x", state: "closed", merged: true }, clock),
      )!.pullRequest.status,
    ).toBe("merged")
    expect(
      parsePullRequestEvent(
        prEvent({ number: 5, head: "x", draft: true }, clock),
      )!.pullRequest.status,
    ).toBe("draft")
    expect(parsePullRequestEvent({ nope: true })).toBeNull()
  })

  it("keys review requests per request so re-requests ping again", () => {
    const first = threadItemFromPullRequestEvent(
      parsePullRequestEvent(
        prEvent(
          {
            number: 5,
            head: "x",
            action: "review_requested",
            requestedReviewer: "hubot",
          },
          clock,
        ),
      )!,
    )!
    const second = threadItemFromPullRequestEvent(
      parsePullRequestEvent(
        prEvent(
          {
            number: 5,
            head: "x",
            action: "review_requested",
            requestedReviewer: "hubot",
            updatedAt: clock.now + 1,
          },
          clock,
        ),
      )!,
    )!
    expect(first.externalKey).not.toBe(second.externalKey)
    expect(first).toMatchObject({
      state: "user",
      targetName: "hubot",
      targetId: 2,
    })
  })

  it("ignores comments on issues and parses comments on PRs", () => {
    const comment = commentEvent({ number: 1, id: 1, body: "x" }) as Record<
      string,
      unknown
    >
    expect(parseActivityEvent("issue_comment", comment)?.activity.type).toBe(
      "thread",
    )
    const issue = { ...comment, issue: { number: 1 } }
    expect(parseActivityEvent("issue_comment", issue)).toBeNull()
  })

  it("parses check runs", () => {
    const parsed = parseActivityEvent(
      "check_run",
      checkRunEvent({
        id: 1,
        name: "test",
        sha: "abc",
        numbers: [3],
        conclusion: "FAILURE",
        at: clock.now,
      }),
    )!
    expect(parsed.pullRequestNumbers).toEqual([3])
    expect(parsed.activity).toMatchObject({
      type: "check",
      check: { state: "failure", headSha: "abc" },
    })
  })

  it("verifies webhook signatures", async () => {
    const body = JSON.stringify({ hello: "world" })
    const signature = `sha256=${await hmacSha256Hex("secret", body)}`
    expect(await verifyGitHubSignature(body, "secret", signature)).toBe(true)
    expect(await verifyGitHubSignature(`${body} `, "secret", signature)).toBe(
      false,
    )
    expect(await verifyGitHubSignature(body, "other", signature)).toBe(false)
    expect(await verifyGitHubSignature(body, "secret", null)).toBe(false)
  })
})

describe("Slack payloads", () => {
  it("verifies request signatures within the replay window", async () => {
    const body = "token=x"
    const timestamp = String(Math.floor(clock.now / 1000))
    const signature = `v0=${await hmacSha256Hex("signing", `v0:${timestamp}:${body}`)}`
    expect(
      await verifySlackSignature(
        body,
        "signing",
        timestamp,
        signature,
        clock.now,
      ),
    ).toBe(true)
    expect(
      await verifySlackSignature(
        body,
        "signing",
        timestamp,
        signature,
        clock.now + 10 * 60_000,
      ),
    ).toBe(false)
  })

  it("answers URL verification and drops bot messages", () => {
    expect(
      parseSlackEnvelope(
        JSON.stringify({ type: "url_verification", challenge: "c" }),
      ),
    ).toEqual({
      kind: "challenge",
      challenge: "c",
    })
    const bot = parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        team_id: "T",
        event_id: "E",
        event_time: 1,
        event: {
          type: "message",
          channel: "C",
          ts: "2",
          thread_ts: "1",
          bot_id: "B",
        },
      }),
    )
    expect(bot).toEqual({ kind: "ignored" })
  })

  it("converts Slack mrkdwn to GitHub Markdown", () => {
    expect(
      slackTextToGitHub(
        "hey <@U1> see <https://a.dev|this> &amp; <https://b.dev>",
        (id) => (id === "U1" ? "octocat" : null),
      ),
    ).toBe("hey @octocat see [this](https://a.dev) & https://b.dev")
  })
})
