#!/usr/bin/env bun
/**
 * A stand-in for the Slack Web API that prints every call, for exercising a
 * local Worker without a Slack workspace:
 *
 *   bun scripts/fake-slack.ts            # listens on :8788
 *   STACKPING_SLACK_API_URL=http://localhost:8788/api STACKPING_STATE=local bun alchemy dev
 */
const port = Number(process.env.PORT ?? 8788)
let ts = 1_000

Bun.serve({
  port,
  async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1)
    const raw = await request.text()
    const body = raw.startsWith("{")
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw))
    console.log(
      `\n── ${method}`,
      body.thread_ts ? `(thread ${body.thread_ts})` : "",
    )
    if (body.text) console.log(body.text)
    switch (method) {
      case "chat.postMessage":
        return Response.json({
          ok: true,
          ts: `${(ts += 1)}.000100`,
          channel: body.channel,
        })
      case "chat.update":
        return Response.json({ ok: true, ts: body.ts })
      case "chat.delete":
        return Response.json({ ok: true })
      default:
        return Response.json({ ok: false, error: "user_not_found" })
    }
  },
})
console.log(`fake Slack listening on http://localhost:${port}/api`)
