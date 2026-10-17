-- NativeKeel team panel (closed beta). Only scan summaries are stored: no source code, no
-- finding details. Tokens are stored as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'view')),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id),
  app TEXT NOT NULL,
  name TEXT,
  scanned_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  react_native TEXT,
  expo TEXT,
  ratings TEXT NOT NULL,
  counts TEXT NOT NULL,
  deadlines TEXT NOT NULL,
  findings TEXT NOT NULL,
  tool_version TEXT
);
CREATE INDEX IF NOT EXISTS scans_team_app ON scans (team_id, app, scanned_at);
CREATE INDEX IF NOT EXISTS scans_team_received ON scans (team_id, received_at);
