import { describe, expect, it } from "bun:test"

import { parseSlackEnvelope } from "../../src/destinations/slack/inbound.ts"
import {
  CHANNEL,
  commentEvent,
  makeHarness,
  prEvent,
  REPO,
} from "../support.ts"

describe("delivery", () => {
  it("honors Slack's Retry-After on rate limits", async () => {
    const h = makeHarness()
    h.slack.failNext("chat.postMessage", "ratelimited", 429, 30)
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    const start = h.clock.now
    await h.settle()
    const posts = h.slack.posts()
    expect(posts).toHaveLength(2)
    expect(h.slack.messages.size).toBe(1)
    expect(h.clock.now - start).toBeGreaterThanOrEqual(30_000)
  })

  it("gives up on permanent Slack errors and reports them", async () => {
    const h = makeHarness()
    h.slack.failNext("chat.postMessage", "not_in_channel")
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()
    expect(h.slack.messages.size).toBe(0)
    const status = h.engine.status()
    expect(status.dead).toBe(1)
    expect(JSON.stringify(status.recentFailures)).toContain("not_in_channel")
  })

  it("reposts a deleted root message and replays its thread", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()
    h.deliver(
      "issue_comment",
      commentEvent({ number: 1, id: 10, body: "hello" }),
    )
    await h.settle()
    const oldRoot = [...h.slack.messages.entries()].find(
      ([, m]) => !m.threadTs,
    )![0]
    h.slack.forget(oldRoot)

    h.advance(1_000)
    h.deliver(
      "pull_request",
      prEvent({ number: 1, head: "feat-a", title: "Renamed" }, h.clock),
    )
    await h.settle()

    const root = [...h.slack.messages.entries()].find(([, m]) => !m.threadTs)!
    expect(root[0]).not.toBe(oldRoot)
    expect(root[1].text).toContain("Renamed")
    const thread = [...h.slack.messages.values()].filter(
      (m) => m.threadTs === root[0],
    )
    expect(thread.map((m) => m.text)).toEqual([
      ":speech_balloon: commented on <https://app.graphite.com/github/pr/acme/web/1|#1>\n> hello",
    ])
  })

  it("spaces writes to the same channel", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    h.deliver("pull_request", prEvent({ number: 2, head: "feat-b" }, h.clock))
    h.deliver("pull_request", prEvent({ number: 3, head: "feat-c" }, h.clock))
    const postTimes: number[] = []
    for (let guard = 0; guard < 50; guard += 1) {
      const next = h.engine.store.nextDueAt()
      if (next === null) break
      if (next > h.clock.now) h.clock.now = next
      const count = h.slack.posts().length
      await h.engine.tick()
      if (h.slack.posts().length > count) postTimes.push(h.clock.now)
    }
    expect(h.slack.posts()).toHaveLength(3)
    expect(postTimes).toHaveLength(3)
    expect(postTimes[1]! - postTimes[0]!).toBeGreaterThanOrEqual(1_250)
    expect(postTimes[2]! - postTimes[1]!).toBeGreaterThanOrEqual(1_250)
  })

  it("stops a tick when the subrequest budget runs out and resumes on the next", async () => {
    const h = makeHarness({
      subrequestBudget: 2,
      config: {
        repos: [{ repo: REPO.fullName, channel: "C0CHANNEL1" }],
      },
    })
    for (let number = 1; number <= 5; number += 1) {
      h.deliver(
        "pull_request",
        prEvent({ number, head: `feat-${number}` }, h.clock),
      )
    }
    h.advance(2_000)
    await h.engine.tick()
    // One post, then the channel is busy; the budget leaves room for more.
    expect(h.slack.posts().length).toBeLessThanOrEqual(2)
    await h.settle()
    expect(h.slack.posts()).toHaveLength(5)
  })
})

describe("Slack replies to GitHub", () => {
  async function postedRoot() {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 7, head: "feat-a" }, h.clock))
    await h.settle()
    const rootTs = [...h.slack.messages.keys()][0]!
    return { h, rootTs }
  }

  function slackEvent(
    rootTs: string,
    event: Record<string, unknown>,
    eventId = `Ev${Math.random()}`,
  ) {
    const parsed = parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: eventId,
        event_time: 1_700_000_000,
        event: {
          type: "message",
          channel: CHANNEL,
          thread_ts: rootTs,
          ...event,
        },
      }),
    )
    if (parsed.kind !== "event") throw new Error(`not an event: ${parsed.kind}`)
    return parsed.event
  }

  it("creates, edits, and deletes the GitHub comment", async () => {
    const { h, rootTs } = await postedRoot()
    expect(
      h.engine.ingestSlack(
        slackEvent(rootTs, {
          ts: "2000.1",
          user: "U0MONALIS",
          text: "ship it <@U0OCTOCAT> <https://x.dev|docs>",
          event_ts: "2000.1",
        }),
      ),
    ).toEqual({ status: "processed" })
    await h.settle()
    const create = h.github.calls.find((call) => call.method === "POST")!
    expect(create.path).toBe("/repos/acme/web/issues/7/comments")
    expect(create.body!.body).toBe(
      "**monalisa** replied in Slack:\n\nship it @octocat [docs](https://x.dev)\n\n<!-- stackping:slack:C0STACKPING:2000.1 -->",
    )

    h.engine.ingestSlack(
      slackEvent(rootTs, {
        subtype: "message_changed",
        event_ts: "2005.1",
        message: {
          ts: "2000.1",
          thread_ts: rootTs,
          user: "U0MONALIS",
          text: "ship it now",
          edited: { ts: "2005.1" },
        },
      }),
    )
    await h.settle()
    const patch = h.github.calls.find((call) => call.method === "PATCH")!
    expect(patch.path).toBe("/repos/acme/web/issues/comments/5001")
    expect(String(patch.body!.body)).toContain("ship it now")

    h.engine.ingestSlack(
      slackEvent(rootTs, {
        subtype: "message_deleted",
        deleted_ts: "2000.1",
        event_ts: "2010.1",
        previous_message: {
          ts: "2000.1",
          thread_ts: rootTs,
          user: "U0MONALIS",
        },
      }),
    )
    await h.settle()
    expect(h.github.calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/repos/acme/web/issues/comments/5001",
    })
  })

  it("ignores threads stackping did not start, and duplicate events", async () => {
    const { h, rootTs } = await postedRoot()
    expect(
      h.engine.ingestSlack(
        slackEvent("9999.9", { ts: "3000.1", user: "U1", text: "hi" }),
      ),
    ).toEqual({ status: "ignored", reason: "not a stackping thread" })
    const event = slackEvent(
      rootTs,
      { ts: "3001.1", user: "U1", text: "hi" },
      "EvSame",
    )
    expect(h.engine.ingestSlack(event)).toEqual({ status: "processed" })
    expect(h.engine.ingestSlack(event)).toEqual({ status: "duplicate" })
  })

  it("can be turned off", async () => {
    const h = makeHarness({ config: { replies: false } })
    h.deliver("pull_request", prEvent({ number: 7, head: "feat-a" }, h.clock))
    await h.settle()
    const rootTs = [...h.slack.messages.keys()][0]!
    expect(
      h.engine.ingestSlack(
        slackEvent(rootTs, { ts: "3000.1", user: "U1", text: "hi" }),
      ),
    ).toEqual({ status: "ignored", reason: "reply sync is disabled" })
  })
})

describe("hourly reconcile", () => {
  function pullRequestNode(spec: {
    number: number
    state?: string
    merged?: boolean
    updatedAt: number
    head: string
    base?: string
    conclusion?: string
  }) {
    return {
      number: spec.number,
      title: `PR ${spec.number}`,
      url: `https://github.com/acme/web/pull/${spec.number}`,
      state: spec.state ?? "OPEN",
      isDraft: false,
      merged: spec.merged ?? false,
      updatedAt: new Date(spec.updatedAt).toISOString(),
      additions: 5,
      deletions: 1,
      changedFiles: 1,
      commitCount: { totalCount: 1 },
      headRefName: spec.head,
      headRefOid: `sha-${spec.number}`,
      baseRefName: spec.base ?? "main",
      headRepository: { databaseId: REPO.id },
      baseRepository: { databaseId: REPO.id },
      author: { login: "octocat", avatarUrl: null, databaseId: 1 },
      reviewRequests: { nodes: [] },
      latestReviews: { nodes: [] },
      lastCommit: {
        nodes: [
          {
            commit: {
              statusCheckRollup: spec.conclusion
                ? {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "test",
                          status: "COMPLETED",
                          conclusion: spec.conclusion,
                          detailsUrl: "https://ci.example/1",
                          completedAt: new Date(spec.updatedAt).toISOString(),
                        },
                      ],
                    },
                  }
                : null,
            },
          },
        ],
      },
    }
  }

  it("catches up on missed webhooks without reposting old PRs", async () => {
    const h = makeHarness()
    h.deliver("pull_request", prEvent({ number: 1, head: "feat-a" }, h.clock))
    await h.settle()
    h.slack.reset()

    h.advance(60 * 60 * 1000)
    h.github.graphql = {
      data: {
        repository: {
          databaseId: REPO.id,
          nameWithOwner: REPO.fullName,
          defaultBranchRef: { name: "main" },
          open: {
            nodes: [
              // Missed opened webhook, recent: should post.
              pullRequestNode({
                number: 2,
                updatedAt: h.clock.now - 60_000,
                head: "feat-b",
              }),
              // Old and never seen: should not post.
              pullRequestNode({
                number: 3,
                updatedAt: h.clock.now - 5 * 24 * 60 * 60 * 1000,
                head: "feat-c",
              }),
            ],
          },
          closed: {
            nodes: [
              // Missed merge of a known PR.
              pullRequestNode({
                number: 1,
                state: "MERGED",
                merged: true,
                updatedAt: h.clock.now - 30_000,
                head: "feat-a",
                conclusion: "SUCCESS",
              }),
            ],
          },
        },
      },
    }
    h.engine.cron()
    await h.settle()

    expect(
      h.github.calls.filter((call) => call.path === "/graphql"),
    ).toHaveLength(1)
    const texts = [...h.slack.messages.values()].map((m) => m.text)
    expect(texts.some((text) => text.includes("#1 MERGED"))).toBe(true)
    expect(texts.some((text) => text.includes("#2 OPEN"))).toBe(true)
    expect(texts.some((text) => text.includes("#3"))).toBe(false)
  })
})
