# stackping

Slack notifications for pull requests, built for teams that ship with
[Graphite](https://graphite.dev) stacks. You run it in your own Cloudflare
account. Nothing goes through a hosted service.

> Early work. Nothing here deploys yet. This README describes what stackping
> will do, and it will change as the code lands.

## What it does

stackping keeps one Slack message per stack and edits it as the stack changes.
It doesn't post a new message for every event.

- The bottom PR of a stack owns the channel message. PRs stacked on top of it
  show up in that message's tree instead of posting their own.
- The root message shows each PR's status, CI health, reviewers, change size,
  and deploy state. Titles link to the PR in Graphite.
- Human comments and reviews go into the message's thread. Bot comments,
  skipped checks, and Graphite's merge-queue boilerplate are dropped.
- CI collapses into one failure summary per stack revision, and that summary
  updates when the build recovers.
- Reviewers mapped to Slack users get a real `@mention`.
- Replies in the Slack thread become comments on the GitHub PR.

Stacks come from GitHub branch relationships. A PR whose base branch is
another open PR's head branch belongs to that PR's stack. stackping never calls
Graphite's API, so it needs no Graphite token.

## How it runs

stackping is one Cloudflare Worker, declared with
[Alchemy](https://alchemy.run).

- The Worker receives signed webhooks from GitHub and Slack.
- A Durable Object with SQLite stores PRs, stacks, and Slack message IDs. It
  serializes writes and Slack calls, so a burst from `gt submit --stack`
  produces one message.
- Alarms and retries handle Slack rate limits and failed deliveries.
- An hourly cron trigger reconciles open PRs in case a webhook got lost.
- Alchemy registers the GitHub webhooks on each repository for you, with a
  generated signing secret.

The configuration is your `alchemy.run.ts`. Which repositories post to which
channel, and which GitHub users map to which Slack users, is code you commit.
There's no dashboard.

## Planned setup

1. Create a Slack app from the manifest in this repository and install it to
   your workspace.
2. Set `CLOUDFLARE_API_TOKEN`, a GitHub token with access to your
   repositories, and the Slack bot token and signing secret.
3. List your repositories and channel in `alchemy.run.ts`.
4. Run `bun alchemy deploy`.

Running `bun alchemy destroy` removes the Worker, its storage, and the GitHub
webhooks it created.

## Roadmap

- Slack first. More destinations after that.
- A GitHub App option for organizations with many repositories, so comments
  synced from Slack come from a bot account instead of a person's token.
