import { DeliveryError } from "../destination.ts"

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const NOT_FOUND_CODES = new Set([
  "message_not_found",
  "thread_not_found",
  "channel_not_found",
])
const RETRYABLE_CODES = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
])

export interface SlackClientOptions {
  readonly token: string
  readonly fetch?: Fetch
  /** Overridable for tests. */
  readonly baseUrl?: string
}

/** A thin Slack Web API client with retry classification. */
export class SlackClient {
  readonly #token: string
  readonly #fetch: Fetch
  readonly #baseUrl: string

  constructor(options: SlackClientOptions) {
    this.#token = options.token
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#baseUrl = options.baseUrl ?? "https://slack.com/api"
  }

  async postMessage(input: {
    readonly channel: string
    readonly text: string
    readonly threadTs?: string
    readonly username?: string | null
    readonly iconUrl?: string | null
  }): Promise<string> {
    const response = await this.call("chat.postMessage", {
      channel: input.channel,
      text: input.text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
      ...(input.username ? { username: input.username } : {}),
      ...(input.iconUrl ? { icon_url: input.iconUrl } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    })
    const ts = stringField(response, "ts")
    if (!ts) {
      throw new DeliveryError({
        code: "invalid_response",
        message: "Slack chat.postMessage response did not include ts",
        retryable: true,
      })
    }
    return ts
  }

  async updateMessage(input: {
    readonly channel: string
    readonly ts: string
    readonly text: string
  }): Promise<void> {
    await this.call("chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: [],
      attachments: [],
    })
  }

  async deleteMessage(input: {
    readonly channel: string
    readonly ts: string
  }): Promise<void> {
    await this.call("chat.delete", { channel: input.channel, ts: input.ts })
  }

  async userProfile(
    userId: string,
  ): Promise<{ name: string; avatarUrl: string | null } | null> {
    const response = await this.call("users.info", { user: userId }, "form")
    const user = record(response.user)
    const profile = record(user?.profile)
    if (!user || !profile) return null
    const name =
      stringField(profile, "display_name") ||
      stringField(profile, "real_name") ||
      stringField(user, "name")
    if (!name) return null
    return {
      name,
      avatarUrl:
        stringField(profile, "image_192") ?? stringField(profile, "image_72"),
    }
  }

  async authTest(): Promise<{
    teamId: string
    team: string
    userId: string
    url: string
  }> {
    const response = await this.call("auth.test", {})
    return {
      teamId: stringField(response, "team_id") ?? "",
      team: stringField(response, "team") ?? "",
      userId: stringField(response, "user_id") ?? "",
      url: stringField(response, "url") ?? "",
    }
  }

  async call(
    method: string,
    body: Readonly<Record<string, unknown>>,
    encoding: "json" | "form" = "json",
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type":
            encoding === "json"
              ? "application/json; charset=utf-8"
              : "application/x-www-form-urlencoded",
        },
        body:
          encoding === "json"
            ? JSON.stringify(body)
            : new URLSearchParams(
                Object.entries(body).map(([key, value]): [string, string] => [
                  key,
                  String(value),
                ]),
              ).toString(),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new DeliveryError({
        code: "network_error",
        message:
          error instanceof Error ? error.message : "Slack request failed",
        retryable: true,
      })
    }

    const retryAfterHeader = response.headers.get("retry-after")
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1_000
      : null

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new DeliveryError({
        code: "invalid_response",
        message: `Slack ${method} returned HTTP ${response.status} with invalid JSON`,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs,
      })
    }

    const result = record(payload)
    if (result === null) {
      throw new DeliveryError({
        code: "invalid_response",
        message: `Slack ${method} returned a non-object response`,
        retryable: true,
        retryAfterMs,
      })
    }
    if (response.ok && result.ok === true) return result

    const code = stringField(result, "error") ?? `http_${response.status}`
    throw new DeliveryError({
      code,
      message: `Slack ${method} failed: ${code}`,
      retryable:
        response.status === 429 ||
        response.status >= 500 ||
        RETRYABLE_CODES.has(code),
      retryAfterMs,
      notFound: NOT_FOUND_CODES.has(code),
    })
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const field = value[key]
  return typeof field === "string" ? field : null
}
