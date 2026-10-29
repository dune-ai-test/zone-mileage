-- Zone Mileage - Cloudflare D1 schema.
--
-- The Pages Function creates this table automatically on its first request.
-- You can also run this file in D1 > your database > Console.
--
-- The dashboard binding must be:
--   Variable name: DB
--   D1 database:   zone-mileage

CREATE TABLE IF NOT EXISTS ledger (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);

-- Optional verification query:
-- SELECT id, version, updated_at, length(payload) AS bytes FROM ledger;
