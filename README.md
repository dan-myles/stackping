# stackping

Slack notifications for pull requests, built for teams that ship with
[Graphite](https://graphite.dev) stacks. It runs in your own Cloudflare
account. Nothing goes through a hosted service.

```sh
bun add -g github:dan-myles/stackping
stackping init
```

`init` asks for your repositories and a Slack channel, logs you in to
Cloudflare, deploys, and walks you through creating the Slack app. It takes a
few minutes.

## What it does

stackping keeps one Slack message per stack and edits it as the stack changes.
It doesn't post a new message for every event.

```
🥞 3 PR STACK  web → main
└─ ✅ #101 APPROVED · feat: add the widget model
   └─ 🟡 #102 OPEN · feat: widget API
      └─ 🟡 #103 OPEN · feat: widget UI

┃ CHECKS ┃ 1 Failing · 11 Passing
┃ CHANGE ┃ +240 −6 · 6 files · 3 commits
┃ REVIEW ┃ @mona ✓, @hubot ○
┃ DEPLOY ┃ Production ready
```

- The bottom PR of a stack owns the channel message. PRs stacked on top of it
  appear in that message's tree. A `gt submit --stack` burst produces one
  message, even when GitHub delivers the child PRs first.
- When the bottom PR merges and Graphite retargets the next one to trunk, the
  next PR takes over the same message and thread.
- Each PR shows its status, CI health, reviewers, change size, and production
  deploy state. Titles link to the PR in Graphite, or to GitHub if you prefer.
- Human comments, reviews, review requests, and merges go into the message's
  thread, posted under the author's Slack name and avatar. Bot comments,
  skipped checks, and Graphite's merge-queue boilerplate are dropped.
- CI collapses into one failure summary per stack revision. The summary edits
  itself when the build recovers.
- Reviewers mapped to Slack users get a real `@mention`. A second review
  request says "re-requested", a second approval says "re-approved".
- Replies in the Slack thread become comments on the GitHub PR. Edits and
  deletes follow.

Stacks come from GitHub branch relationships. A PR whose base branch is
another open PR's head branch belongs to that PR's stack. stackping never calls
Graphite's API, so it needs no Graphite token.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- A Cloudflare account. The Workers Free plan works for small teams. Busy
  organizations should use Workers Paid ($5/month); see [Limits](#limits).
- Admin access to the GitHub repositories, so stackping can add webhooks. The
  [GitHub CLI](https://cli.github.com) login is enough.
- Permission to create an app in your Slack workspace.

## Setup

`stackping init` does all of this interactively. Here is what it does, so you
know what you're agreeing to.

1. Writes `stackping.json` with your repositories and channel.
2. Logs you in to Cloudflare in the browser (or uses `CLOUDFLARE_API_TOKEN`
   and `CLOUDFLARE_ACCOUNT_ID`).
3. Deploys the Worker so Slack has a URL to verify.
4. Opens Slack's "Create an app" page with stackping's manifest filled in.
   You install the app and paste the bot token and signing secret.
5. Asks for an optional fine-grained GitHub token for the Worker. Without one,
   Slack replies stay in Slack and missed webhooks are not backfilled.
6. Asks which GitHub logins map to which Slack members.
7. Saves the secrets to `.env.stackping`, which it adds to `.gitignore`.
8. Deploys again and posts a hello message in the channel.

Commit `stackping.json`. Don't commit `.env.stackping`.

### The GitHub token for the Worker

Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
for the watched repositories with:

- Pull requests: read and write
- Issues: read and write
- Commit statuses, Checks, Deployments: read

Comments synced from Slack are posted by the token's owner, with the Slack
author's name at the top. A GitHub App option that posts as a bot is on the
roadmap.

## Commands

| Command               | What it does                                             |
| --------------------- | -------------------------------------------------------- |
| `stackping init`      | Interactive setup, from nothing to a working channel     |
| `stackping deploy`    | Applies changes to `stackping.json`                      |
| `stackping status`    | Checks the Worker's health and recent delivery failures  |
| `stackping logs [-f]` | Prints Worker logs, or streams them with `-f`            |
| `stackping manifest`  | Prints the Slack app manifest and its create-app link    |
| `stackping dev`       | Runs the Worker locally with `alchemy dev`               |
| `stackping destroy`   | Removes the Worker, its storage, and the GitHub webhooks |

All commands read `./stackping.json`, or the file passed with `--config`.

## Configuration

```json
{
  "stage": "prod",
  "slack": { "channel": "C0123ABCD" },
  "repos": [
    { "repo": "acme/web" },
    { "repo": "acme/api", "channel": "C0456EFGH", "trunks": ["develop"] }
  ],
  "users": { "octocat": "U0123ABCD" },
  "links": "graphite",
  "replies": true
}
```

| Field                | Meaning                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `stage`              | Deployment name. The Worker is called `stackping-<stage>`. Defaults to `prod`.                                           |
| `slack.channel`      | Channel ID for every repository without its own `channel`.                                                               |
| `repos[].trunks`     | Long-lived branches besides the default branch. A PR from `develop` to `main` is a promotion, not the bottom of a stack. |
| `users`              | GitHub login to Slack member ID.                                                                                         |
| `links`              | `graphite` or `github`.                                                                                                  |
| `replies`            | Sync Slack thread replies to GitHub comments. Defaults to `true`.                                                        |
| `deploy.environment` | Regular expression for the deployment environment shown in `DEPLOY`. Defaults to `\bprod(uction)?\b`.                    |

Secrets come from the environment or `.env.stackping`: `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, and `STACKPING_GITHUB_TOKEN`. To deploy from CI, set
those plus `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and a
`GITHUB_TOKEN` that can manage repository webhooks, then run
`stackping deploy`.

## How it runs

stackping is one Cloudflare Worker and one SQLite Durable Object, declared with
[Alchemy](https://alchemy.run).

- The Worker checks GitHub and Slack signatures and hands the raw request to
  the Durable Object. It does no parsing, so it stays well under the Free
  plan's 10 ms CPU limit, and GitHub and Slack get an answer in milliseconds.
- The Durable Object stores PRs, checks, reviews, and Slack message IDs in
  SQLite. Each change schedules a job in an outbox table. Jobs for the same
  message merge, so ten check runs finishing together cause one edit.
- An alarm drains the outbox. It spaces writes to a channel 1.25 seconds
  apart, retries Slack and GitHub failures with backoff, and honors
  `Retry-After`. If someone deletes the stack message, stackping posts it again
  and replays the thread.
- An hourly cron asks GitHub (one GraphQL request per repository) for open and
  recently closed PRs, in case a webhook got lost.
- Alchemy registers a webhook on each repository with a generated signing
  secret. `stackping destroy` removes them.
- Alchemy keeps deployment state in your Cloudflare account, so you can deploy
  from any machine that has the secrets.

The code is organized around one seam for future destinations besides Slack.
`src/domain` builds destination-neutral views of stacks and thread activity.
`src/destinations/slack` renders and sends them. A new destination implements
the `Destination` interface in `src/destinations/destination.ts`.

## Limits

On Workers Free, each alarm can make 50 outbound requests. stackping spends at
most 40 per alarm and then schedules another, so bursts take a few seconds
longer but never fail. The Free plan also allows 100,000 Durable Object row
writes a day. A team with a handful of busy repositories stays well inside
that. If your CI runs hundreds of jobs per push, use Workers Paid and set
`STACKPING_SUBREQUEST_BUDGET` higher.

## Development

```sh
bun install
bun run ck                        # types, tests, format, lint
cp stackping.example.json stackping.json
bun scripts/fake-slack.ts &       # prints every Slack call
STACKPING_STATE=local STACKPING_SLACK_API_URL=http://localhost:8788/api \
  bun alchemy dev --stage dev
bun scripts/replay.ts pull_request test/fixtures/stack/pr-1-opened.json
```

`alchemy dev` runs the Worker and Durable Object in local workerd. GitHub can't
reach localhost, so dev skips the repository webhooks; `scripts/replay.ts`
sends signed fixtures instead. To receive real webhooks, run a tunnel such as
`cloudflared tunnel --url localhost:1337` and set `STACKPING_PUBLIC_URL`.

The engine tests run against `bun:sqlite` with fake Slack and GitHub APIs, so
`bun test` needs no network.

## Roadmap

- More destinations after Slack.
- A GitHub App option for organizations with many repositories, so comments
  synced from Slack come from a bot account instead of a person's token.
