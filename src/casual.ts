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
  if (!Number.isSafeInteger(body.durationSec) || body.durationSec < 60 ||
      body.durationSec > 3 * 60 * 60) {
    return c.json({ error: "implausible duration" }, 400);
  }

  if (body.stats !== undefined &&
      (!body.stats || typeof body.stats !== "object" || Array.isArray(body.stats))) {
    return c.json({ error: "bad stats" }, 400);
  }
  const s = body.stats ?? {};
  const validOptionalStat = (value: unknown, max: number): boolean =>
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && value <= max);
  if (!validOptionalStat(s.elims, 10_000) || !validOptionalStat(s.tags, 10_000) ||
      !validOptionalStat(s.objective, 10_000) || !validOptionalStat(s.builder, 100_000) ||
      (s.completed !== undefined && typeof s.completed !== "boolean") ||
      (s.won !== undefined && typeof s.won !== "boolean")) {
    return c.json({ error: "bad stats" }, 400);
  }

  const now = nowSec();

  const stats: PlayerStats = {
    elims: s.elims ?? 0, tags: s.tags ?? 0,
    objective: s.objective ?? 0, builder: s.builder ?? 0,
    completed: s.completed ?? false, won: s.won ?? false,
  };
  // Same rule set as fleet, but never the first-of-day daily bonus (casual must not out-earn fleet).
  const baseEvents = computeXpEvents(stats, /*isFirstMatchOfDay=*/false);

  // What this match wants before the cap (halved, floored per event exactly as it is granted below).
  let want = 0;
  for (const e of baseEvents) want += Math.max(0, Math.floor(e.amount * CASUAL_XP_FACTOR));
  const dayStart =
    Math.floor((now - CASUAL_DAY_RESET_OFFSET_SEC) / 86400) * 86400 + CASUAL_DAY_RESET_OFFSET_SEC;
  const processingToken = crypto.randomUUID();
  const ownsReport = `EXISTS (
    SELECT 1 FROM casual_reports
    WHERE user_id = ? AND match_id = ? AND processing_token = ? AND processed_at IS NULL)`;
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO casual_reports
         (user_id, match_id, created_at, processing_token, processed_at, granted)
       VALUES (?, ?, ?, ?, NULL, 0)
       ON CONFLICT(user_id, match_id) DO NOTHING`)
      .bind(userId, body.matchId, now, processingToken),
    c.env.DB.prepare(
      `UPDATE casual_reports SET processing_token = ?
       WHERE user_id = ? AND match_id = ? AND processed_at IS NULL AND processing_token IS NULL`)
      .bind(processingToken, userId, body.matchId),
  ];

  if (want > 0) {
    // Root claim, daily-cap claim, ledger write, and profile projection are one D1 batch. A failure
    // rolls back every step, so a retry neither burns the match id nor consumes daily capacity.
    stmts.push(c.env.DB.prepare(
      `INSERT INTO casual_daily_xp (user_id, day_start, used, last_grant)
       SELECT ?, ?, 0, 0 WHERE ${ownsReport}
       ON CONFLICT(user_id, day_start) DO NOTHING`)
      .bind(userId, dayStart, userId, body.matchId, processingToken));
    stmts.push(c.env.DB.prepare(
      `UPDATE casual_daily_xp
       SET last_grant = MIN(?, used + ?) - used,
           used = MIN(?, used + ?)
       WHERE user_id = ? AND day_start = ? AND used < ? AND ${ownsReport}`)
      .bind(CASUAL_DAILY_XP_CAP, want, CASUAL_DAILY_XP_CAP, want,
        userId, dayStart, CASUAL_DAILY_XP_CAP, userId, body.matchId, processingToken));
    stmts.push(c.env.DB.prepare(
      `UPDATE casual_reports
       SET granted = COALESCE((
         SELECT last_grant FROM casual_daily_xp WHERE user_id = ? AND day_start = ?), 0)
       WHERE user_id = ? AND match_id = ? AND processing_token = ? AND processed_at IS NULL`)
      .bind(userId, dayStart, userId, body.matchId, processingToken));
    stmts.push(c.env.DB.prepare(
      `INSERT INTO xp_events (user_id, match_id, source, amount, rule_version, meta, created_at)
       SELECT user_id, match_id, 'casual_match', granted, ?, ?, ?
       FROM casual_reports
       WHERE user_id = ? AND match_id = ? AND processing_token = ? AND processed_at IS NULL
         AND granted > 0
       ON CONFLICT(match_id, user_id, source) DO NOTHING`)
      .bind(RULE_VERSION, JSON.stringify({ casual: true, requested: want }), now,
        userId, body.matchId, processingToken));
    stmts.push(c.env.DB.prepare(
      `INSERT INTO app_profiles (user_id, xp_total, playtime_sec, matches_played, updated_at)
       SELECT user_id, granted, ?, 1, ? FROM casual_reports
       WHERE user_id = ? AND match_id = ? AND processing_token = ? AND processed_at IS NULL
         AND granted > 0
       ON CONFLICT(user_id) DO UPDATE SET
         xp_total = xp_total + excluded.xp_total,
         playtime_sec = playtime_sec + excluded.playtime_sec,
         matches_played = matches_played + 1,
         updated_at = excluded.updated_at`)
      .bind(body.durationSec, now, userId, body.matchId, processingToken));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE casual_reports SET processed_at = ?, processing_token = NULL
     WHERE user_id = ? AND match_id = ? AND processing_token = ? AND processed_at IS NULL`)
    .bind(now, userId, body.matchId, processingToken));

  const results = await c.env.DB.batch(stmts);
  const owned = (results[0]?.meta?.changes ?? 0) > 0 || (results[1]?.meta?.changes ?? 0) > 0;
  if (!owned) return c.json({ ok: true, duplicate: true, granted: 0 });

  const completed = await c.env.DB.prepare(
    `SELECT granted FROM casual_reports WHERE user_id = ? AND match_id = ?`)
    .bind(userId, body.matchId).first();
  const gained = (completed?.granted as number) ?? 0;
  if (gained <= 0) return c.json({ ok: true, granted: 0, capped: want > 0 });

  // Recompute level + evaluate unlocks (level-gated cosmetics/weapons light up as usual).
  try {
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
  } catch (error) {
    console.error("post-casual projection failed", { userId, error: String(error) });
  }

  return c.json({ ok: true, granted: gained });
});
