-- Existing-production upgrade for the Epic release hardening. Wrangler records this migration in
-- its D1 migrations table, applies it transactionally, and will not apply it twice.

ALTER TABLE app_profiles ADD COLUMN builder INTEGER NOT NULL DEFAULT 0;

ALTER TABLE matches ADD COLUMN processing_token TEXT;
ALTER TABLE matches ADD COLUMN processed_at INTEGER;
UPDATE matches SET processed_at = COALESCE(ended_at, strftime('%s','now')) WHERE processed_at IS NULL;

ALTER TABLE casual_reports ADD COLUMN processing_token TEXT;
ALTER TABLE casual_reports ADD COLUMN processed_at INTEGER;
ALTER TABLE casual_reports ADD COLUMN granted INTEGER NOT NULL DEFAULT 0;
UPDATE casual_reports SET processed_at = created_at WHERE processed_at IS NULL;

CREATE TABLE daily_bonus_claims (
  user_id    TEXT NOT NULL,
  day_start  INTEGER NOT NULL,
  match_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day_start)
);

-- Preserve historical daily grants when seeding the new concurrency-safe claim table.
INSERT OR IGNORE INTO daily_bonus_claims (user_id, day_start, match_id, created_at)
SELECT user_id, CAST(created_at / 86400 AS INTEGER) * 86400, match_id, created_at
FROM xp_events WHERE source = 'daily'
ORDER BY created_at;

CREATE TABLE promo_redemptions (
  code           TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  redeemed_at    INTEGER NOT NULL,
  claim_token    TEXT NOT NULL UNIQUE,
  PRIMARY KEY (code, user_id)
);

-- Correct the seed typo without overwriting any other operator-authored definition.
UPDATE unlock_definitions
SET criteria = '{"type":"stat","stat":"builder","gte":500}'
WHERE unlock_id = 'badge_builder_500'
  AND criteria = '{"type":"stat","stat":"tags","gte":500}';
