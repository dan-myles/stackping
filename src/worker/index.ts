import type { Env } from "./env.ts"

import {
  parseSlackEnvelope,
  verifySlackSignature,
} from "../destinations/slack/inbound.ts"
import {
  GITHUB_WEBHOOK_EVENTS,
  verifyGitHubSignature,
} from "../domain/github.ts"

export { Hub } from "./hub.ts"

const MAX_BODY_BYTES = 5_000_000
const SUPPORTED_EVENTS = new Set<string>(GITHUB_WEBHOOK_EVENTS)

/**
 * The Worker only verifies signatures and hands raw bodies to the Hub, so it
 * stays well inside the Workers Free 10 ms CPU limit. All parsing and
 * delivery happens in the Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return health(env)
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      return handleGitHub(request, env)
    }
    if (request.method === "POST" && url.pathname === "/webhooks/slack") {
      return handleSlack(request, env)
    }
    return json({ error: "not found" }, 404)
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(hub(env).cron())
  },
}

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName("hub"))
}

async function health(env: Env): Promise<Response> {
  const status = (await hub(env).status()) as Record<string, unknown>
  return json({
    ok: true,
    service: "stackping",
    version: env.STACKPING_VERSION ?? null,
    slack: Boolean(env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET),
    github: Boolean(env.GITHUB_TOKEN),
    ...status,
  })
}

async function handleGitHub(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request)
  if (body === null) return json({ error: "payload too large" }, 413)
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return json({ error: "webhook secret is not configured" }, 503)
  }
  const valid = await verifyGitHubSignature(
    body,
    env.GITHUB_WEBHOOK_SECRET,
    request.headers.get("x-hub-signature-256"),
  )
  if (!valid) return json({ error: "invalid signature" }, 401)

  const event = request.headers.get("x-github-event") ?? ""
  const deliveryId = request.headers.get("x-github-delivery") ?? ""
  if (event === "ping") return json({ ok: true, pong: true })
  if (!SUPPORTED_EVENTS.has(event)) {
    return json({ status: "ignored", reason: `unsupported ${event}` }, 202)
  }
  const result = await hub(env).ingestGitHub({ deliveryId, event, body })
  return json(result, 202)
}

async function handleSlack(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request)
  if (body === null) return json({ error: "payload too large" }, 413)

  if (!env.SLACK_SIGNING_SECRET) {
    // Before the Slack app exists there is no secret yet; answering the
    // URL check lets Slack accept the request URL during app creation.
    const envelope = parseSlackEnvelope(body)
    return envelope.kind === "challenge"
      ? json({ challenge: envelope.challenge })
      : json({ error: "signing secret is not configured" }, 503)
  }

  const valid = await verifySlackSignature(
    body,
    env.SLACK_SIGNING_SECRET,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature"),
  )
  if (!valid) return json({ error: "invalid signature" }, 401)

  const envelope = parseSlackEnvelope(body)
  switch (envelope.kind) {
    case "challenge":
      return json({ challenge: envelope.challenge })
    case "event":
      return json(await hub(env).ingestSlack(envelope.event))
    case "ignored":
      return json({ status: "ignored" })
    case "invalid":
      return json({ error: "invalid payload" }, 400)
  }
}

async function readBody(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > MAX_BODY_BYTES) return null
  const body = await request.text()
  return new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES
    ? null
    : body
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}
