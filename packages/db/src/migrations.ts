/**
 * Schema migrations, applied in order. The index + 1 is stored in
 * `PRAGMA user_version`. Never edit a migration that has shipped; add a new one.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: project metadata, the zoom tree, and the command history log */ `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE nodes (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES nodes(id),
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    seed       INTEGER NOT NULL,
    pos_x      REAL NOT NULL DEFAULT 0,
    pos_y      REAL NOT NULL DEFAULT 0,
    pos_z      REAL NOT NULL DEFAULT 0,
    notes      TEXT NOT NULL DEFAULT '',
    tags       TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX nodes_parent ON nodes(parent_id);

  CREATE TABLE command_log (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    action  TEXT NOT NULL,
    source  TEXT NOT NULL,
    type    TEXT NOT NULL,
    command TEXT NOT NULL,
    inverse TEXT NOT NULL
  );
  `
]

export const SCHEMA_VERSION = MIGRATIONS.length
