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

CREATE TABLE IF NOT EXISTS session_processes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL
  -- 子进程台账（M1）：spawn 记 pid、dispose 撤销、重启孤儿清点。一行一会话——
  -- 同会话重拉 UPSERT 覆盖旧行；pid 是 server 重启后唯一可追认的现场，故必须落库不可放内存。
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
  -- 一次性配对码（M1）：8 位数字、5min 有效、单次核销。CLI `aimi-server pair` 与运行服务
  -- 跨进程共库消费，核销原子性靠 UPDATE … WHERE used_at IS NULL（不可放内存，review §3.3）。
);
