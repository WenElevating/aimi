-- aimi M0 权威存储 schema（§D 规则 4：只追加，禁止 DROP/改列）。
-- 全部 CREATE TABLE IF NOT EXISTS：migrate 幂等，重复启动无副作用。

CREATE TABLE IF NOT EXISTS meta_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default','plan')),
  state TEXT NOT NULL,
  resume_hint TEXT,                -- M1：每适配器自述
  last_seq INTEGER NOT NULL DEFAULT 0,
  initial_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,           -- AgentEvent JSON
  PRIMARY KEY (session_id, seq)    -- 重放=点查（§D 规则 6）
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  revoked_at INTEGER,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cmd_dedup (
  client_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  ts INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT
);
