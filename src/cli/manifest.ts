/** Bot scopes stackping uses; `users:read` lets posts carry Slack names and avatars. */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "chat:write.customize",
  "chat:write.public",
  "channels:history",
  "groups:history",
  "users:read",
] as const

/** A Slack app manifest pointed at a deployed stackping Worker. */
export function slackManifest(
  workerUrl: string,
  options: { replies: boolean },
) {
  return {
    display_information: {
      name: "stackping",
      description: "One Slack message per pull request stack.",
      background_color: "#1d1f24",
    },
    features: {
      bot_user: { display_name: "stackping", always_online: true },
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      ...(options.replies
        ? {
            event_subscriptions: {
              request_url: `${workerUrl.replace(/\/+$/, "")}/webhooks/slack`,
              bot_events: ["message.channels", "message.groups"],
            },
          }
        : {}),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}

/** Opens Slack's "Create an app" flow with the manifest filled in. */
export function createAppUrl(manifest: unknown): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`
}
