-- Mods backend schema (docs/MODS-DESIGN.md, "Data model"). Blobs (mod bundles, diffs) live in R2;
-- these tables hold metadata and point at them by key.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                       -- sha-256 of the anonymous device id; accounts later
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consent_store INTEGER NOT NULL DEFAULT 0,  -- needed for the feature: keep my mods and prompts
  consent_sweep INTEGER NOT NULL DEFAULT 0   -- optional: let the daily sweep read them across users
);

CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,                        -- scrubbed of emails, phone numbers, urls
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  result_kind TEXT NOT NULL,                 -- 'mod' | 'branch' | 'none'
  result_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX prompts_user ON prompts(user_id, created_at);

CREATE TABLE mods (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  manifest TEXT NOT NULL,                    -- json
  sdk_version TEXT NOT NULL,
  bundle_key TEXT NOT NULL,                  -- R2 key of the module source
  hash TEXT NOT NULL,                        -- sha-256 of manifest + module, what saves and lobbies compare
  parent_mod_id TEXT REFERENCES mods(id),    -- set when a follow-up prompt edits an earlier mod
  visibility TEXT NOT NULL DEFAULT 'private',-- 'private' | 'shared'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX mods_author ON mods(author_id, created_at);
CREATE UNIQUE INDEX mods_author_hash ON mods(author_id, hash);

CREATE TABLE mod_installs (
  user_id TEXT NOT NULL REFERENCES users(id),
  mod_id TEXT NOT NULL REFERENCES mods(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  PRIMARY KEY (user_id, mod_id)
);

CREATE TABLE code_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  prompt_id TEXT REFERENCES prompts(id),
  branch TEXT NOT NULL,
  base_sha TEXT,
  diff_key TEXT,                             -- R2 key of the diff
  build_status TEXT NOT NULL DEFAULT 'queued',-- queued | running | built | failed | rebase_failed
  preview_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opt-in usage events (installed, enabled, played a match with, removed) for the sweep
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  mod_id TEXT,
  data TEXT,                                 -- json
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX events_created ON events(created_at);

CREATE TABLE intent_clusters (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  member_ids TEXT NOT NULL,                  -- json: prompt, mod and code_change ids
  user_count INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'        -- open | proposed | merged | rejected
);

CREATE TABLE upstream_proposals (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES intent_clusters(id),
  kind TEXT NOT NULL,                        -- bug | feature | sdk-hook
  pr_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',       -- open | merged | closed
  migrated_user_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
