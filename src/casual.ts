import { Hono } from "hono";
import type { Env } from "./env";
import { nowSec } from "./env";
import { computeXpEvents, levelForXp, RULE_VERSION, type PlayerStats } from "./xp";
import { evaluateUnlocks } from "./reports";

/**
 * /v1/casual-report — XP for LOCAL / listen-hosted / offline matches (Tom 2026-07-18).
 *
 * Contrast with /v1/match-report (the fleet path): that one is authenticated by a per-server key + HMAC and
 * is fully trusted. THIS route is authenticated only by the PLAYER'S OWN session (requireSession in index.ts)
 * and reports the player's OWN stats — so it is HONOR-SYSTEM and cannot be trusted. Tom's call: allow it now,
 * "face the cheating problem later once we have real users." Damage control until then:
 *   - only ever credits the submitting user (c.get('userId')) — a client can't mint XP for anyone else
 *   - casual XP is HALVED vs fleet AND capped hard per user per day (CASUAL_DAILY_XP_CAP), where
 *     "day" resets at CASUAL_DAY_RESET_OFFSET_SEC, NOT UTC midnight (which fell mid-evening in the US)
 *   - every event is tagged source 'casual_*' with meta {casual:true} — fully auditable + voidable later
 *     (rollback = DELETE FROM xp_events WHERE source LIKE 'casual_%', plus casual_reports and
 *      casual_daily_xp, then rebuild app_profiles from the ledger)
 *   - idempotent on (userId, matchId) via the casual_reports INSERT below — that row is the
 *     idempotency ROOT and the FIRST write, exactly like the matches INSERT in reports.ts
 *   - does NOT grant the big daily-bonus and never inserts a matches/match_players row (those stay fleet-only)
 *   - env CASUAL_XP_ENABLED must be "1"/"true" to run at all; anything else (including unset) = off
 */

const CASUAL_XP_FACTOR = 0.5;       // casual matches earn half of the fleet XP for the same stats
const CASUAL_DAILY_XP_CAP = 1500;   // hard ceiling on casual XP per user per day (~1 fleet match's worth)
// The cap day resets at 10:00 UTC (~6am ET / 3am PT) instead of UTC midnight. UTC midnight is 7/8pm
// ET — right in the middle of a kids' evening session — so an honest player crossed it mid-session
// and earned 3,000 in one sitting. Still exactly one 1,500 window per 24h; only the seam moved.
const CASUAL_DAY_RESET_OFFSET_SEC = 10 * 3600;

export const casualRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

casualRoutes.post("/casual-report", async (c) => {
  // FAIL-SAFE kill switch: only an explicit affirmative runs the honor-system path. The old test was
  // `=== "0"`, so an unset binding (which is what shipped — CASUAL_XP_ENABLED was in no [vars] block),
  // "false", "off", or any typo left the endpoint fully live while looking disabled. wrangler.toml now
  // ships CASUAL_XP_ENABLED = "1"; flip it to anything else and redeploy to yank the feature.
  const enabled = c.env.CASUAL_XP_ENABLED === "1" || c.env.CASUAL_XP_ENABLED === "true";
  if (!enabled) {
    return c.json({ ok: true, disabled: true, granted: 0 });
  }
  const userId = c.get("userId");
  const body = await c.req.json<{
    matchId: string; mode?: string; map?: string; durationSec: number;
    stats: {
      elims?: number; tags?: number; objective?: number; builder?: number;
      completed?: boolean; won?: boolean;
    };
  }>().catch(() => null);

  if (!body || typeof body.matchId !== "string" || !body.matchId || body.matchId.length > 64) {
    return c.json({ error: "bad matchId" }, 400);
  }
  if (!(body.durationSec >= 60) || body.durationSec > 3 * 60 * 60) {
    return c.json({ error: "implausible duration" }, 400);
  }

  const now = nowSec();

  // Idempotency ROOT — mirrors the matches INSERT in reports.ts. This MUST be the FIRST write.
  // What it replaces: a `SELECT 1 FROM xp_events ... LIMIT 1` guard, which N concurrent posts of the
  // same matchId ALL passed before any of them wrote. The xp_events INSERTs below then collapsed on
  // their UNIQUE(match_id,user_id,source) — but the app_profiles upsert is an unconditional
  // `xp_total = xp_total + excluded.xp_total` and ran N times. 50 parallel curls minted ~28,750 XP
  // against this 1,500 cap, and left xp_total permanently above the ledger (so schema.sql's "pure
  // projection" claim and the "delete casual_% rows to roll back" claim were both false).
  // A UNIQUE-keyed INSERT is the only dedupe the database can arbitrate under concurrency.
  const rootClaim = await c.env.DB.prepare(
    `INSERT INTO casual_reports (user_id, match_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, match_id) DO NOTHING`)
    .bind(userId, body.matchId, now).run();
  if ((rootClaim.meta?.changes ?? 0) === 0) {
    return c.json({ ok: true, duplicate: true, granted: 0 });
  }

  const s = body.stats ?? {};
  const stats: PlayerStats = {
    elims: Math.max(0, s.elims! | 0), tags: Math.max(0, s.tags! | 0),
    objective: Math.max(0, s.objective! | 0), builder: Math.max(0, s.builder! | 0),
    completed: !!s.completed, won: !!s.won,
  };
  // Same rule set as fleet, but never the first-of-day daily bonus (casual must not out-earn fleet).
  const baseEvents = computeXpEvents(stats, /*isFirstMatchOfDay=*/false);

  // What this match wants before the cap (halved, floored per event exactly as it is granted below).
  let want = 0;
  for (const e of baseEvents) want += Math.max(0, Math.floor(e.amount * CASUAL_XP_FACTOR));
  if (want <= 0) return c.json({ ok: true, granted: 0 });

  const dayStart =
    Math.floor((now - CASUAL_DAY_RESET_OFFSET_SEC) / 86400) * 86400 + CASUAL_DAY_RESET_OFFSET_SEC;

  // Daily cap as an atomic CLAIM, not read-then-write. The old code SUM()ed today's casual XP and
  // only wrote much later, so concurrent requests all saw the same `used` and each granted in full —
  // the 1,500 ceiling was advisory. A single UPDATE is one implicit transaction in D1, and SQLite
  // evaluates every SET expression against the PRE-update row, so `last_grant` is exactly what THIS
  // call won (0 if another request took the rest of the day's budget first).
  await c.env.DB.prepare(
    `INSERT INTO casual_daily_xp (user_id, day_start, used, last_grant) VALUES (?, ?, 0, 0)
     ON CONFLICT(user_id, day_start) DO NOTHING`).bind(userId, dayStart).run();
  const claimed = await c.env.DB.prepare(
    `UPDATE casual_daily_xp
        SET last_grant = MIN(?, used + ?) - used,
            used       = MIN(?, used + ?)
      WHERE user_id = ? AND day_start = ? AND used < ?
      RETURNING last_grant`)
    .bind(CASUAL_DAILY_XP_CAP, want, CASUAL_DAILY_XP_CAP, want, userId, dayStart, CASUAL_DAILY_XP_CAP)
    .all<{ last_grant: number }>();
  let remaining = (claimed.results?.[0]?.last_grant as number) ?? 0;
  if (remaining <= 0) return c.json({ ok: true, granted: 0, capped: true });

  const stmts: D1PreparedStatement[] = [];
  let gained = 0;
  for (const e of baseEvents) {
    if (remaining <= 0) break;
    let amt = Math.floor(e.amount * CASUAL_XP_FACTOR);
    if (amt <= 0) continue;
    amt = Math.min(amt, remaining);
    remaining -= amt;
    gained += amt;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO xp_events (user_id, match_id, source, amount, rule_version, meta, created_at)
       VALUES (?, ?, ?, ?, ?, '{"casual":true}', ?)
       ON CONFLICT(match_id, user_id, source) DO NOTHING`)
      .bind(userId, body.matchId, `casual_${e.source}`, amt, RULE_VERSION, now));
  }

  if (gained <= 0) return c.json({ ok: true, granted: 0 });

  stmts.push(c.env.DB.prepare(
    `INSERT INTO app_profiles (user_id, xp_total, playtime_sec, matches_played, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       xp_total = xp_total + excluded.xp_total,
       playtime_sec = playtime_sec + excluded.playtime_sec,
       matches_played = matches_played + 1,
       updated_at = excluded.updated_at`)
    .bind(userId, gained, body.durationSec | 0, now));
  await c.env.DB.batch(stmts);

  // Recompute level + evaluate unlocks (level-gated cosmetics/weapons light up as usual).
  const prof = await c.env.DB.prepare(
    "SELECT xp_total, level FROM app_profiles WHERE user_id = ?").bind(userId).first();
  if (prof) {
    const newLevel = levelForXp(prof.xp_total as number);
    if (newLevel !== prof.level) {
      await c.env.DB.prepare("UPDATE app_profiles SET level = ? WHERE user_id = ?")
        .bind(newLevel, userId).run();
    }
    await evaluateUnlocks(c.env, userId);
  }

  return c.json({ ok: true, granted: gained });
});
