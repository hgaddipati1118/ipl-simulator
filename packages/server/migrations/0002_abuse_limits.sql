-- Counters for abuse limits (src/limits.ts). Keys look like "ip:<hash>:generate" or
-- "global:generate"; one row per key per UTC day, pruned by the daily cron.
CREATE TABLE usage_counters (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
