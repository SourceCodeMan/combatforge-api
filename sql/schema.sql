-- combatforge-api application schema (D1/SQLite).
-- Better Auth's own tables live in auth-schema.sql; these are the game-side tables.
-- Design: docs/progression-plan.md + docs/multiplayer-plan.md in the combatforge repo.
-- Everything is ADDITIVE from here — new unlocks/entitlements are INSERTs, never migrations.

-- ---- identity bridge: install GUID (SHA1 hash, the game's pre-account identity) -> account ----
CREATE TABLE IF NOT EXISTS identities (
  guid_hash    TEXT PRIMARY KEY,                  -- 40 lowercase hex (matches ServerSetPlayerGuidHash)
  user_id      TEXT NOT NULL,                     -- Better Auth user.id
  linked_at    INTEGER NOT NULL,                  -- unix seconds
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- ---- progression profile: PURE PROJECTION of xp_events (rebuildable, never the truth) ----
CREATE TABLE IF NOT EXISTS app_profiles (
  user_id          TEXT PRIMARY KEY,
  xp_total         INTEGER NOT NULL DEFAULT 0,
  level            INTEGER NOT NULL DEFAULT 1,
  playtime_sec     INTEGER NOT NULL DEFAULT 0,
  matches_played   INTEGER NOT NULL DEFAULT 0,
  wins             INTEGER NOT NULL DEFAULT 0,
  eliminations     INTEGER NOT NULL DEFAULT 0,
  times_eliminated INTEGER NOT NULL DEFAULT 0,
  tags             INTEGER NOT NULL DEFAULT 0,
  builder          INTEGER NOT NULL DEFAULT 0,
  per_mode         TEXT NOT NULL DEFAULT '{}',    -- JSON: per-mode stat rollups
  last_event_id    INTEGER NOT NULL DEFAULT 0,    -- projection watermark
  updated_at       INTEGER NOT NULL DEFAULT 0
);

-- ---- append-only XP ledger (audit / replay / recovery / clean COPPA deletion) ----
CREATE TABLE IF NOT EXISTS xp_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  match_id     TEXT NOT NULL,
  source       TEXT NOT NULL,                     -- completion|elim|objective|win|daily|builder|manual_adjust|...
  amount       INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  UNIQUE(match_id, user_id, source)               -- second belt behind matches.match_id dedupe
);
CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id, id);

-- ---- casual (local/listen/offline) XP: idempotency root + daily-cap ledger ----
-- Casual reports deliberately never write a matches row (fleet-only), so they had NO idempotency
-- root: the old SELECT-then-write dedupe let N concurrent posts of one matchId all pass and each
-- bump app_profiles, breaking the "pure projection" contract above. This table is that root — the
-- UNIQUE PK is the only check the DB itself can arbitrate under concurrency.
CREATE TABLE IF NOT EXISTS casual_reports (
  user_id          TEXT NOT NULL,
  match_id         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  processing_token TEXT,
  processed_at     INTEGER,
  granted          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, match_id)
);

-- Per-user, per-day claimed casual XP. Exists so the cap can be an ATOMIC CLAIM (one conditional
-- UPDATE) instead of a SUM()-then-write race where every concurrent request reads the same total.
-- last_grant holds what the most recent claim won: SQLite evaluates all SET expressions against the
-- PRE-update row, so `MIN(cap, used + want) - used` is exact even under contention.
-- day_start is NOT UTC midnight — see CASUAL_DAY_RESET_OFFSET_SEC in src/casual.ts.
-- Full casual rollback is now THREE deletes: xp_events (source LIKE 'casual_%'), casual_reports,
-- casual_daily_xp — plus a rebuild of app_profiles from the ledger.
CREATE TABLE IF NOT EXISTS casual_daily_xp (
  user_id    TEXT NOT NULL,
  day_start  INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  last_grant INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_start)
);

-- ---- match history (idempotency root: match_id PK — a re-sent report can never double-grant) ----
CREATE TABLE IF NOT EXISTS matches (
  match_id     TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL,
  mode         TEXT NOT NULL,
  map          TEXT NOT NULL,
  arena_id     TEXT,
  started_at   INTEGER,
  ended_at     INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  winner_team  INTEGER NOT NULL,                  -- 0/1, 255 = draw/none
  net_protocol INTEGER NOT NULL,
  raw          TEXT NOT NULL,                     -- full report JSON (replay source)
  processing_token TEXT,                          -- owns the all-or-nothing D1 processing batch
  processed_at INTEGER
);

-- Atomic first-match-of-day claim. The unique key, rather than a read-then-write query against
-- xp_events, decides which concurrent match receives the daily bonus.
CREATE TABLE IF NOT EXISTS daily_bonus_claims (
  user_id    TEXT NOT NULL,
  day_start  INTEGER NOT NULL,
  match_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day_start)
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id   TEXT NOT NULL,
  user_id    TEXT,                                -- NULL until the guid links to an account (retro-attach)
  guid_hash  TEXT NOT NULL,
  team       INTEGER NOT NULL,
  elims      INTEGER NOT NULL DEFAULT 0,
  times_elim INTEGER NOT NULL DEFAULT 0,
  score      INTEGER NOT NULL DEFAULT 0,
  tags       INTEGER NOT NULL DEFAULT 0,
  objective  INTEGER NOT NULL DEFAULT 0,          -- objective points (captures/returns/plants/defuses rolled up)
  builder    INTEGER NOT NULL DEFAULT 0,          -- pieces surviving to round end
  completed  INTEGER NOT NULL DEFAULT 0,          -- bool: finished the match (anti-ragequit)
  is_bot     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, guid_hash)
);
CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);

-- ---- data-driven unlocks (new unlock = INSERT; criteria/payload are JSON) ----
CREATE TABLE IF NOT EXISTS unlock_definitions (
  unlock_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                       -- cosmetic_part|weapon_paint|splat_color|title|badge|host_map
  criteria   TEXT NOT NULL,                       -- JSON: {"type":"level","gte":10} | {"type":"stat","stat":"tags","gte":500} | {"type":"entitlement","id":"all_access"}
  payload    TEXT NOT NULL,                       -- JSON: {"slot":"Headwear","partIndex":12} etc. (game interprets)
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_unlocks (
  user_id         TEXT NOT NULL,
  unlock_id       TEXT NOT NULL,
  granted_at      INTEGER NOT NULL,
  source_event_id INTEGER,                        -- xp_events.id that triggered it (NULL = entitlement/manual)
  PRIMARY KEY (user_id, unlock_id)
);

-- ---- store: entitlements (purchases/comps) + promo codes ----
-- The "unlock everything" pack = entitlement 'all_access'; purchases happen on the WEBSITE
-- (merchant-of-record checkout), never in-client. Comps = promo codes granting the same entitlement.
CREATE TABLE IF NOT EXISTS entitlements (
  user_id        TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,                   -- 'all_access' | future packs
  granted_at     INTEGER NOT NULL,
  source         TEXT NOT NULL,                   -- purchase:<order-id> | promo:<code> | admin
  PRIMARY KEY (user_id, entitlement_id)
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code           TEXT PRIMARY KEY,                -- unambiguous alphabet, admin-minted
  entitlement_id TEXT NOT NULL,
  max_uses       INTEGER NOT NULL DEFAULT 1,
  uses           INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER,                         -- NULL = never
  created_at     INTEGER NOT NULL,
  note           TEXT
);

-- Durable per-user redemption record. claim_token ties a newly inserted redemption to the same
-- transactional batch that increments promo_codes.uses and grants the entitlement.
CREATE TABLE IF NOT EXISTS promo_redemptions (
  code           TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  redeemed_at    INTEGER NOT NULL,
  claim_token    TEXT NOT NULL UNIQUE,
  PRIMARY KEY (code, user_id)
);

-- ---- dedicated fleet: server identities + live directory ----
CREATE TABLE IF NOT EXISTS game_servers (
  server_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL,                       -- SHA-256 hex of the per-instance secret
  region     TEXT NOT NULL DEFAULT 'us-east',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_status (
  server_id    TEXT PRIMARY KEY,
  addr         TEXT NOT NULL,                     -- Worker-observed public IP
  lan_addr     TEXT,                              -- self-reported (same-LAN hairpin fallback)
  port         INTEGER NOT NULL,
  map          TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL DEFAULT '',
  format       TEXT NOT NULL DEFAULT '',
  phase        TEXT NOT NULL DEFAULT '',
  players      INTEGER NOT NULL DEFAULT 0,
  max_players  INTEGER NOT NULL DEFAULT 12,
  net_protocol INTEGER NOT NULL DEFAULT 0,
  private      INTEGER NOT NULL DEFAULT 0,
  join_code    TEXT,                              -- 6-char, private matches only
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_status_seen ON server_status(last_seen_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_status_code ON server_status(join_code) WHERE join_code IS NOT NULL;
