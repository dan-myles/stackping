import type { Hub } from "./hub.ts"

/** Bindings the stack attaches to the Worker (see `src/stack.ts`). */
export interface Env {
  readonly HUB: DurableObjectNamespace<Hub>
  /** Resolved `StackpingConfig` as JSON. */
  readonly STACKPING_CONFIG: string
  readonly STACKPING_VERSION?: string
  /** Generated at deploy time and shared with the GitHub webhooks. */
  readonly GITHUB_WEBHOOK_SECRET?: string
  readonly SLACK_BOT_TOKEN?: string
  readonly SLACK_SIGNING_SECRET?: string
  /** Optional: enables the hourly reconcile and Slack → GitHub replies. */
  readonly GITHUB_TOKEN?: string
  /** Outbound requests per alarm; 40 suits Workers Free (limit 50). */
  readonly STACKPING_SUBREQUEST_BUDGET?: string
  /** Local testing only: alternate API base URLs. */
  readonly SLACK_API_URL?: string
  readonly GITHUB_API_URL?: string
}
