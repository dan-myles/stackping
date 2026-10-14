import * as Schema from "effect/Schema"

const repoName = Schema.String.check(
  Schema.isPattern(/^[\w.-]+\/[\w.-]+$/, {
    message: "must look like owner/name",
  }),
)
const channelId = Schema.String.check(
  Schema.isPattern(/^[CG][A-Z0-9]{6,}$/, {
    message: "must be a Slack channel ID like C0123ABCD",
  }),
)
const slackUserId = Schema.String.check(
  Schema.isPattern(/^[UW][A-Z0-9]{6,}$/, {
    message: "must be a Slack member ID like U0123ABCD",
  }),
)
const stageName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+([-_a-z0-9]+)*$/, {
    message: "must be lowercase letters, digits, - or _",
  }),
)

const repoEntry = Schema.Struct({
  repo: repoName,
  channel: Schema.optional(channelId),
  trunks: Schema.optional(Schema.Array(Schema.String)),
})

const configFile = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  stage: Schema.optional(stageName),
  slack: Schema.Struct({ channel: channelId }),
  repos: Schema.Array(repoEntry),
  users: Schema.optional(Schema.Record(Schema.String, slackUserId)),
  links: Schema.optional(Schema.Literals(["graphite", "github"])),
  deploy: Schema.optional(
    Schema.Struct({ environment: Schema.optional(Schema.String) }),
  ),
  replies: Schema.optional(Schema.Boolean),
  /** The deployed Worker URL, recorded by the CLI. */
  url: Schema.optional(Schema.String),
})

export type StackpingConfigFile = typeof configFile.Type

export interface RepoConfig {
  readonly repo: string
  readonly channel: string
  readonly trunks: ReadonlyArray<string>
}

/** Fully resolved configuration, shared by the CLI, the stack, and the Worker. */
export interface StackpingConfig {
  readonly stage: string
  readonly slack: { readonly channel: string }
  readonly repos: ReadonlyArray<RepoConfig>
  /** GitHub login (lowercase) → Slack member ID. */
  readonly users: Readonly<Record<string, string>>
  readonly links: "graphite" | "github"
  /** Regular expression source matched against deployment environment names. */
  readonly deployEnvironment: string
  /** Whether Slack thread replies become GitHub PR comments. */
  readonly replies: boolean
}

export const DEFAULT_DEPLOY_ENVIRONMENT = "\\bprod(uction)?\\b"

export class ConfigError extends Error {
  override readonly name = "ConfigError"
}

export function parseConfig(input: unknown): StackpingConfig {
  let file: StackpingConfigFile
  try {
    file = Schema.decodeUnknownSync(configFile)(input)
  } catch (error) {
    throw new ConfigError(
      `Invalid stackping config: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (file.repos.length === 0) {
    throw new ConfigError("Invalid stackping config: repos must not be empty")
  }

  const seen = new Set<string>()
  const repos = file.repos.map((entry) => {
    const repo = entry.repo.toLowerCase()
    if (seen.has(repo)) {
      throw new ConfigError(`Invalid stackping config: ${repo} is listed twice`)
    }
    seen.add(repo)
    return {
      repo,
      channel: entry.channel ?? file.slack.channel,
      trunks: entry.trunks ?? [],
    }
  })

  const environment = file.deploy?.environment ?? DEFAULT_DEPLOY_ENVIRONMENT
  try {
    new RegExp(environment, "i")
  } catch {
    throw new ConfigError(
      `Invalid stackping config: deploy.environment is not a valid regular expression`,
    )
  }

  return {
    stage: file.stage ?? "prod",
    slack: { channel: file.slack.channel },
    repos,
    users: Object.fromEntries(
      Object.entries(file.users ?? {}).map(([login, id]) => [
        login.toLowerCase(),
        id,
      ]),
    ),
    links: file.links ?? "graphite",
    deployEnvironment: environment,
    replies: file.replies ?? true,
  }
}

export function repoConfig(
  config: StackpingConfig,
  repositoryFullName: string,
): RepoConfig | undefined {
  const name = repositoryFullName.toLowerCase()
  return config.repos.find((entry) => entry.repo === name)
}
