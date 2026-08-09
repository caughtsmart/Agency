-- Workings — lead capture schema.
--
--   npx wrangler d1 execute workings-leads --remote --file=./schema.sql
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,          -- ISO 8601, UTC
  email       TEXT    NOT NULL,
  company     TEXT,
  source      TEXT,                      -- e.g. waste-audit-WA1
  total       INTEGER NOT NULL,          -- annual cost of manual admin, £
  recoverable INTEGER NOT NULL,          -- 55% of the above, £
  hours       REAL    NOT NULL,          -- hours a week across all six tasks
  rate        REAL    NOT NULL,          -- loaded hourly cost, £
  weeks       REAL    NOT NULL,          -- trading weeks a year
  tasks_json  TEXT    NOT NULL,          -- [{name,hrs,cost}, …]
  ip_trunc    TEXT,                      -- last octet zeroed. Never the full IP.
  user_agent  TEXT,
  notified    INTEGER NOT NULL DEFAULT 0 -- 1 once the [LEAD] email actually sent
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads (email);

-- Rate limiting. One row per accepted request, counted over a rolling hour and
-- pruned on write. ip_key is a salted SHA-256 of the IP — it is not reversible
-- and it is not the IP.
CREATE TABLE IF NOT EXISTS rate_hits (
  ip_key TEXT    NOT NULL,
  ts     INTEGER NOT NULL              -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits (ip_key, ts);
