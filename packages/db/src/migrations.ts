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
  `,
  /* 2: world settings, terrain edit layers (zlib-compressed), and regions */ `
  CREATE TABLE worlds (
    id                TEXT PRIMARY KEY REFERENCES nodes(id),
    settings          TEXT,
    terrain_revision  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE terrain_layers (
    world_id  TEXT NOT NULL REFERENCES nodes(id),
    layer     TEXT NOT NULL,
    face      INTEGER NOT NULL,
    data      BLOB NOT NULL,
    PRIMARY KEY (world_id, layer, face)
  );

  CREATE TABLE regions (
    id         TEXT PRIMARY KEY,
    world_id   TEXT NOT NULL REFERENCES nodes(id),
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    points     TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX regions_world ON regions(world_id);
  `,
  /* 3: timeline records (events, links, groups, eras, lanes, entity changes, settings) as JSON documents */ `
  CREATE TABLE records (
    kind       TEXT NOT NULL,
    id         TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES nodes(id),
    data       TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX records_owner ON records(kind, owner_id);
  `,
  /* 4: files kept in the project, such as imported glTF models */ `
  CREATE TABLE assets (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL
  );
  `
]

export const SCHEMA_VERSION = MIGRATIONS.length
