import { constantTimeEqual, hmacSha256Hex } from "../../domain/github.ts"

export interface SlackReplyEvent {
  readonly eventId: string
  readonly teamId: string
  /** Seconds, with Slack's microsecond precision, for ordering edits. */
  readonly eventTime: number
  readonly operation: "create" | "update" | "delete"
  readonly channel: string
  readonly ts: string
  readonly threadTs: string
  readonly slackUserId: string | null
  readonly text: string | null
}

export type SlackEnvelope =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "ignored" }
  | { readonly kind: "event"; readonly event: SlackReplyEvent }
  | { readonly kind: "invalid" }

export async function verifySlackSignature(
  payload: string,
  secret: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): Promise<boolean> {
  const seconds = Number(timestamp)
  if (
    !timestamp ||
    !signature?.startsWith("v0=") ||
    !Number.isFinite(seconds) ||
    Math.abs(now / 1_000 - seconds) > 5 * 60
  ) {
    return false
  }
  const expected = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${payload}`)}`
  return constantTimeEqual(expected, signature)
}

/** Parses an Events API request into a thread-reply event, if it is one. */
export function parseSlackEnvelope(payload: string): SlackEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      payload.startsWith("payload=")
        ? (new URLSearchParams(payload).get("payload") ?? "")
        : payload,
    )
  } catch {
    return { kind: "invalid" }
  }
  const envelope = record(parsed)
  if (envelope === null) return { kind: "invalid" }
  if (envelope.type === "url_verification") {
    return typeof envelope.challenge === "string"
      ? { kind: "challenge", challenge: envelope.challenge }
      : { kind: "invalid" }
  }
  if (envelope.type !== "event_callback") return { kind: "ignored" }

  const teamId = stringField(envelope, "team_id")
  const eventId = stringField(envelope, "event_id")
  const eventTime = numberField(envelope, "event_time")
  const event = record(envelope.event)
  if (!teamId || !eventId || eventTime === null || event?.type !== "message") {
    return { kind: "ignored" }
  }

  if (event.subtype === "message_changed") {
    const message = record(event.message)
    if (message === null || isBotMessage(message)) return { kind: "ignored" }
    return normalized(eventId, teamId, eventTime, "update", event, message)
  }
  if (event.subtype === "message_deleted") {
    const previous = record(event.previous_message)
    if (previous === null || isBotMessage(previous)) return { kind: "ignored" }
    const deletedTs = stringField(event, "deleted_ts")
    if (!deletedTs) return { kind: "ignored" }
    return normalized(eventId, teamId, eventTime, "delete", event, {
      ...previous,
      ts: deletedTs,
    })
  }
  if (event.subtype !== undefined || isBotMessage(event)) {
    return { kind: "ignored" }
  }
  return normalized(eventId, teamId, eventTime, "create", event, event)
}

/** Converts Slack mrkdwn mentions and links to GitHub Markdown. */
export function slackTextToGitHub(
  text: string,
  githubLoginForSlackUser: (slackUserId: string) => string | null,
): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, userId: string) => {
      const login = githubLoginForSlackUser(userId)
      return login ? `@${login}` : `@${userId}`
    })
    .replace(/<([^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<([^>]+)>/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
}

function normalized(
  eventId: string,
  teamId: string,
  eventTime: number,
  operation: SlackReplyEvent["operation"],
  outer: Record<string, unknown>,
  message: Record<string, unknown>,
): SlackEnvelope {
  const channel =
    stringField(outer, "channel") ?? stringField(message, "channel")
  const ts = stringField(message, "ts")
  const threadTs = stringField(message, "thread_ts")
  if (!channel || !ts || !threadTs || ts === threadTs) {
    return { kind: "ignored" }
  }
  const edited = record(message.edited)
  const precise = Number(
    stringField(edited ?? {}, "ts") ??
      stringField(outer, "event_ts") ??
      eventTime,
  )
  return {
    kind: "event",
    event: {
      eventId,
      teamId,
      eventTime: Number.isFinite(precise) ? precise : eventTime,
      operation,
      channel,
      ts,
      threadTs,
      slackUserId: stringField(message, "user"),
      text: operation === "delete" ? null : stringField(message, "text"),
    },
  }
}

function isBotMessage(value: Record<string, unknown>): boolean {
  return (
    typeof value.bot_id === "string" ||
    typeof value.app_id === "string" ||
    value.subtype === "bot_message"
  )
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key]
  return typeof field === "string" ? field : null
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const field = value[key]
  return typeof field === "number" ? field : null
}
