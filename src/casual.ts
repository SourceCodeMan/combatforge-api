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
 *   - casual XP is HALVED vs fleet AND capped hard per user per UTC day (CASUAL_DAILY_XP_CAP)
 *   - every event is tagged source 'casual_*' with meta {casual:true} — fully auditable + voidable later
 *     (a single DELETE FROM xp_events WHERE source LIKE 'casual_%' rolls the whole experiment back)
 *   - idempotent on matchId (a re-send credits nothing)
 *   - does NOT grant the big daily-bonus and never inserts a matches/match_players row (those stay fleet-only)
 *   - env CASUAL_XP_ENABLED="0" yanks the feature back to server-only instantly (no redeploy of the game)
 */

const CASUAL_XP_FACTOR = 0.5;       // casual matches earn half of the fleet XP for the same stats
const CASUAL_DAILY_XP_CAP = 1500;   // hard ceiling on casual XP per user per UTC day (~1 fleet match's worth)

export const casualRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

casualRoutes.post("/casual-report", async (c) => {
  if ((c.env as any).CASUAL_XP_ENABLED === "0") {
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

  // Idempotency: if this match already granted the user casual XP, ack and add nothing (safe re-send).
  const dup = await c.env.DB.prepare(
    "SELECT 1 FROM xp_events WHERE user_id = ? AND match_id = ? AND source LIKE 'casual_%' LIMIT 1")
    .bind(userId, body.matchId).first();
  if (dup) return c.json({ ok: true, duplicate: true, granted: 0 });

  const now = nowSec();
  const dayStart = Math.floor(now / 86400) * 86400;

  // Per-day casual cap: how much casual XP has this user already banked today?
  const capRow = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS used FROM xp_events WHERE user_id = ? AND source LIKE 'casual_%' AND created_at >= ?")
    .bind(userId, dayStart).first();
  let remaining = CASUAL_DAILY_XP_CAP - ((capRow?.used as number) ?? 0);
  if (remaining <= 0) return c.json({ ok: true, granted: 0, capped: true });

  const s = body.stats ?? {};
  const stats: PlayerStats = {
    elims: Math.max(0, s.elims! | 0), tags: Math.max(0, s.tags! | 0),
    objective: Math.max(0, s.objective! | 0), builder: Math.max(0, s.builder! | 0),
    completed: !!s.completed, won: !!s.won,
  };
  // Same rule set as fleet, but never the first-of-day daily bonus (casual must not out-earn fleet).
  const baseEvents = computeXpEvents(stats, /*isFirstMatchOfDay=*/false);

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
