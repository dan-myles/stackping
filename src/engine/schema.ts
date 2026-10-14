import type { Sql } from "./sql.ts"

import { one } from "./sql.ts"

/** Append-only. Each entry runs once, in order, inside a transaction. */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE prs (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    author_id INTEGER NOT NULL,
    author_login TEXT NOT NULL,
    author_avatar TEXT,
    status TEXT NOT NULL,
    head_repo_id INTEGER NOT NULL,
    head_ref TEXT NOT NULL,
    head_sha TEXT,
    base_repo_id INTEGER NOT NULL,
    base_ref TEXT NOT NULL,
    default_branch TEXT,
    parent_id TEXT,
    previous_parent_id TEXT,
    reviewers TEXT NOT NULL,
    reviewer_teams TEXT NOT NULL,
    additions INTEGER NOT NULL,
    deletions INTEGER NOT NULL,
    changed_files INTEGER NOT NULL,
    commit_count INTEGER NOT NULL,
    github_updated_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX prs_head ON prs (head_repo_id, head_ref);
  CREATE INDEX prs_base ON prs (base_repo_id, base_ref);
  CREATE INDEX prs_parent ON prs (parent_id);
  CREATE INDEX prs_head_sha ON prs (repo_id, head_sha);
  CREATE INDEX prs_status_updated ON prs (status, github_updated_at);

  CREATE TABLE pr_checks (
    pr_id TEXT NOT NULL,
    source TEXT NOT NULL,
    name_key TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    url TEXT,
    head_sha TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (pr_id, source, name_key)
  );

  CREATE TABLE pr_reviews (
    pr_id TEXT NOT NULL,
    reviewer_id INTEGER NOT NULL,
    login TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (pr_id, reviewer_id)
  );

  CREATE TABLE pr_deployments (
    pr_id TEXT PRIMARY KEY,
    environment TEXT NOT NULL,
    state TEXT NOT NULL,
    url TEXT,
    head_sha TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    pr_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id INTEGER,
    actor_login TEXT,
    actor_avatar TEXT,
    body TEXT,
    url TEXT,
    state TEXT,
    path TEXT,
    line INTEGER,
    target_name TEXT,
    target_id INTEGER,
    deleted INTEGER NOT NULL,
    edited INTEGER NOT NULL,
    review_kind TEXT,
    occurred_at INTEGER NOT NULL,
    source_updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX items_pr ON items (pr_id, occurred_at);

  CREATE TABLE review_history (
    item_id TEXT PRIMARY KEY,
    pr_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    has_approved INTEGER NOT NULL,
    occurred_at INTEGER NOT NULL
  );
  CREATE INDEX review_history_target ON review_history (pr_id, target_type, target_id);

  CREATE TABLE messages (
    key TEXT PRIMARY KEY,
    pr_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    render_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX messages_ts ON messages (channel, ts);
  CREATE INDEX messages_thread ON messages (channel, thread_ts);
  CREATE INDEX messages_pr ON messages (pr_id);

  CREATE TABLE outbox (
    key TEXT PRIMARY KEY,
    channel TEXT,
    payload TEXT,
    due_at INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    last_error TEXT,
    dead INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX outbox_due ON outbox (dead, due_at);

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX deliveries_received ON deliveries (received_at);

  CREATE TABLE reply_links (
    slack_key TEXT PRIMARY KEY,
    pr_id TEXT NOT NULL,
    comment_id INTEGER NOT NULL,
    last_event_time REAL NOT NULL
  );

  CREATE TABLE slack_profiles (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    avatar_url TEXT,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
]

export function migrate(sql: Sql): void {
  sql.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  )
  const current =
    one<{ version: number | null }>(
      sql,
      "SELECT MAX(version) AS version FROM schema_migrations",
    )?.version ?? 0

  MIGRATIONS.forEach((migration, index) => {
    const version = index + 1
    if (version <= current) return
    sql.transaction(() => {
      for (const statement of splitStatements(migration)) sql.run(statement)
      sql.run("INSERT INTO schema_migrations (version) VALUES (?)", version)
    })
  })
}

function splitStatements(script: string): string[] {
  return script
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
