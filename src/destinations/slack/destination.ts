import type {
  CiSummaryView,
  MessageRef,
  PullRequestView,
  StackView,
  ThreadItemView,
  UserDirectory,
} from "../../domain/view.ts"
import type { Destination, PostTarget, Rendered } from "../destination.ts"
import type { SlackClient } from "./client.ts"

import { DeliveryError } from "../destination.ts"
import {
  RENDER_VERSION,
  renderCiSummary,
  renderMovedMessage,
  renderStackMessage,
  renderThreadItem,
} from "./render.ts"

export interface SlackRendered extends Rendered {
  readonly text: string
  readonly username: string | null
  readonly iconUrl: string | null
}

export interface SlackProfile {
  readonly name: string
  readonly avatarUrl: string | null
}

/** Resolves a Slack member's display name and avatar, usually from a cache. */
export type ProfileLookup = (
  slackUserId: string,
) => Promise<SlackProfile | null>

/**
 * Posts as the GitHub author: their Slack name and avatar when the login is
 * mapped, otherwise their GitHub login and avatar (`chat:write.customize`).
 */
export class SlackDestination implements Destination<SlackRendered> {
  readonly id = "slack"
  readonly spacingMs = 1_250
  readonly #client: SlackClient
  readonly #profiles: ProfileLookup

  constructor(client: SlackClient, profiles: ProfileLookup) {
    this.#client = client
    this.#profiles = profiles
  }

  async renderStack(view: StackView): Promise<SlackRendered> {
    const identity = await this.#identity(
      view.root.authorLogin,
      view.root.authorAvatarUrl,
      view.users,
    )
    return rendered(renderStackMessage(view), identity)
  }

  async renderThreadItem(view: ThreadItemView): Promise<SlackRendered> {
    const identity = view.actorLogin
      ? await this.#identity(view.actorLogin, view.actorAvatarUrl, view.users)
      : { username: "GitHub activity", iconUrl: null }
    return rendered(renderThreadItem(view), identity)
  }

  async renderCiSummary(view: CiSummaryView): Promise<SlackRendered> {
    return rendered(renderCiSummary(view), { username: null, iconUrl: null })
  }

  async renderMoved(
    pr: Pick<PullRequestView, "number" | "url">,
    root: Pick<PullRequestView, "number" | "url">,
  ): Promise<SlackRendered> {
    return rendered(renderMovedMessage(pr, root), {
      username: null,
      iconUrl: null,
    })
  }

  async post(target: PostTarget, message: SlackRendered): Promise<MessageRef> {
    const ts = await this.#client.postMessage({
      channel: target.channel,
      text: message.text,
      threadTs: target.threadTs,
      username: message.username,
      iconUrl: message.iconUrl,
    })
    return { channel: target.channel, ts }
  }

  async update(ref: MessageRef, message: SlackRendered): Promise<void> {
    await this.#client.updateMessage({
      channel: ref.channel,
      ts: ref.ts,
      text: message.text,
    })
  }

  async remove(ref: MessageRef): Promise<"deleted" | "missing"> {
    try {
      await this.#client.deleteMessage(ref)
      return "deleted"
    } catch (error) {
      if (error instanceof DeliveryError && error.notFound) return "missing"
      if (
        error instanceof DeliveryError &&
        error.code === "cant_delete_message"
      ) {
        // Messages posted before a reinstall can belong to a different bot.
        await this.#client.updateMessage({
          channel: ref.channel,
          ts: ref.ts,
          text: "_(removed)_",
        })
        return "deleted"
      }
      throw error
    }
  }

  async #identity(
    login: string,
    avatarUrl: string | null,
    users: UserDirectory,
  ): Promise<{ username: string | null; iconUrl: string | null }> {
    const slackUserId = users[login.toLowerCase()]
    const profile = slackUserId ? await this.#profiles(slackUserId) : null
    return {
      username: profile?.name ?? login,
      iconUrl: profile?.avatarUrl ?? avatarUrl,
    }
  }
}

function rendered(
  text: string,
  identity: { username: string | null; iconUrl: string | null },
): SlackRendered {
  return { key: `${RENDER_VERSION}:${text}`, text, ...identity }
}
