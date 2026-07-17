import { Hono } from "hono";
import type { Env } from "./env";
import { nowSec } from "./env";
import { sha256Hex, hmacSha256Hex, timingSafeEqualHex, MAX_TIMESTAMP_SKEW_SEC } from "./hmac";
import { computeXpEvents, levelForXp, RULE_VERSION, type PlayerStats } from "./xp";

/**
 * /v1/match-report — the ONLY XP entry point (docs/progression-plan.md §1).
 * Fleet servers report RAW STATS at CommitMatchRecord time; the Worker computes XP.
 * Auth: per-server key (Bearer) + HMAC-SHA256 of the raw body with the same key
 * (X-Signature, X-Timestamp; ±10 min skew). Idempotent on matches.match_id — a re-sent
 * report acks 200 {duplicate:true} and appends nothing.
 * Listen/player-hosted matches can never reach this: no server key, no XP. Bots earn nothing.
 */

export interface MatchReport {
  matchId: string;
  mode: string;
  map: string;
  arenaId?: string;
  startedAt?: number;
  endedAt: number;
  durationSec: number;
  winnerTeam: number; // 0/1, 255 = draw
  netProtocol: number;
  players: Array<{
    guidHash: string;
    userId?: string;   // present when the join was token-authenticated
    team: number;
    elims: number;
    timesElim: number;
    score: number;
    tags: number;
    objective: number;
    builder: number;
    completed: boolean;
    isBot?: boolean;
  }>;
}

export const reportRoutes = new Hono<{ Bindings: Env }>();

reportRoutes.post("/match-report", async (c) => {
  // -- authenticate the fleet server --
  const authz = c.req.header("Authorization") ?? "";
  const key = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!key) return c.json({ error: "missing server key" }, 401);
  const server = await c.env.DB.prepare(
    "SELECT server_id FROM game_servers WHERE key_hash = ? AND active = 1")
    .bind(await sha256Hex(key)).first();
  if (!server) return c.json({ error: "unknown server key" }, 403);

  // -- verify HMAC + timestamp (replay window) --
  const rawBody = await c.req.text();
  const ts = Number(c.req.header("X-Timestamp") ?? "0");
  const sig = c.req.header("X-Signature") ?? "";
  if (!ts || Math.abs(nowSec() - ts) > MAX_TIMESTAMP_SKEW_SEC) {
    return c.json({ error: "stale timestamp" }, 401);
  }
  const expected = await hmacSha256Hex(key, `${ts}.${rawBody}`);
  if (!timingSafeEqualHex(expected, sig)) return c.json({ error: "bad signature" }, 401);

  let report: MatchReport;
  try {
    report = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "bad json" }, 400);
  }

  // -- plausibility clamps (defense-in-depth even with a valid key) --
  if (!report.matchId || typeof report.matchId !== "string" || report.matchId.length > 64) {
    return c.json({ error: "bad matchId" }, 400);
  }
  if (!Array.isArray(report.players) || report.players.length === 0 || report.players.length > 12) {
    return c.json({ error: "bad roster" }, 400);
  }
  if (report.durationSec < 30 || report.durationSec > 3 * 60 * 60) {
    return c.json({ error: "implausible duration" }, 400);
  }

  // -- idempotency root: INSERT the match; conflict = already processed --
  const inserted = await c.env.DB.prepare(
    `INSERT INTO matches (match_id, server_id, mode, map, arena_id, started_at, ended_at,
       duration_sec, winner_team, net_protocol, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_id) DO NOTHING`)
    .bind(report.matchId, server.server_id as string, report.mode ?? "", report.map ?? "",
      report.arenaId ?? null, report.startedAt ?? null, report.endedAt ?? nowSec(),
      report.durationSec, report.winnerTeam ?? 255, report.netProtocol ?? 0, rawBody)
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    return c.json({ ok: true, duplicate: true });
  }

  const now = nowSec();
  const stmts: D1PreparedStatement[] = [];
  const grantedUsers: string[] = [];

  for (const p of report.players) {
    if (!p?.guidHash || !/^[0-9a-f]{40}$/.test(p.guidHash)) continue;

    // Resolve the account: explicit userId (token join) or the identities bridge.
    let userId = p.userId ?? null;
    if (!userId) {
      const link = await c.env.DB.prepare(
        "SELECT user_id FROM identities WHERE guid_hash = ?").bind(p.guidHash).first();
      userId = (link?.user_id as string) ?? null;
    }

    stmts.push(c.env.DB.prepare(
      `INSERT INTO match_players (match_id, user_id, guid_hash, team, elims, times_elim, score,
         tags, objective, builder, completed, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, guid_hash) DO NOTHING`)
      .bind(report.matchId, userId, p.guidHash, p.team ?? 255,
        p.elims | 0, p.timesElim | 0, p.score | 0, p.tags | 0,
        p.objective | 0, p.builder | 0, p.completed ? 1 : 0, p.isBot ? 1 : 0));

    if (!userId || p.isBot) continue; // no account (yet) or bot: history recorded, no XP

    // First MATCH of the day (participation-gated, UTC day).
    const dayStart = Math.floor(now / 86400) * 86400;
    const daily = await c.env.DB.prepare(
      "SELECT 1 FROM xp_events WHERE user_id = ? AND source = 'daily' AND created_at >= ? LIMIT 1")
      .bind(userId, dayStart).first();

    const stats: PlayerStats = {
      elims: p.elims | 0, tags: p.tags | 0, objective: p.objective | 0, builder: p.builder | 0,
      completed: !!p.completed,
      won: report.winnerTeam !== 255 && p.team === report.winnerTeam,
    };
    const events = computeXpEvents(stats, !daily);
    for (const e of events) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO xp_events (user_id, match_id, source, amount, rule_version, meta, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?)
         ON CONFLICT(match_id, user_id, source) DO NOTHING`)
        .bind(userId, report.matchId, e.source, e.amount, RULE_VERSION, now));
    }

    // Projection update (rebuildable from the ledger at any time).
    const xpGain = events.reduce((a, e) => a + e.amount, 0);
    stmts.push(c.env.DB.prepare(
      `INSERT INTO app_profiles (user_id, xp_total, playtime_sec, matches_played, wins,
         eliminations, times_eliminated, tags, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         xp_total = xp_total + excluded.xp_total,
         playtime_sec = playtime_sec + excluded.playtime_sec,
         matches_played = matches_played + 1,
         wins = wins + excluded.wins,
         eliminations = eliminations + excluded.eliminations,
         times_eliminated = times_eliminated + excluded.times_eliminated,
         tags = tags + excluded.tags,
         updated_at = excluded.updated_at`)
      .bind(userId, xpGain, report.durationSec, stats.won ? 1 : 0,
        stats.elims, p.timesElim | 0, stats.tags, now));
    grantedUsers.push(userId);
  }

  if (stmts.length > 0) {
    await c.env.DB.batch(stmts);
  }

  // Second pass: recompute levels + evaluate data-driven unlocks for the granted users.
  for (const userId of grantedUsers) {
    const prof = await c.env.DB.prepare(
      "SELECT xp_total, level FROM app_profiles WHERE user_id = ?").bind(userId).first();
    if (!prof) continue;
    const newLevel = levelForXp(prof.xp_total as number);
    if (newLevel !== prof.level) {
      await c.env.DB.prepare("UPDATE app_profiles SET level = ? WHERE user_id = ?")
        .bind(newLevel, userId).run();
    }
    await evaluateUnlocks(c.env, userId);
  }

  return c.json({ ok: true, granted: grantedUsers.length });
});

/** Phase-C evaluation step: criteria vs profile/entitlements → user_unlocks INSERTs (additive). */
export async function evaluateUnlocks(env: Env, userId: string): Promise<number> {
  const [{ results: defs }, prof, { results: owned }, { results: ents }] = await Promise.all([
    env.DB.prepare("SELECT unlock_id, criteria FROM unlock_definitions WHERE active = 1").all(),
    env.DB.prepare("SELECT * FROM app_profiles WHERE user_id = ?").bind(userId).first(),
    env.DB.prepare("SELECT unlock_id FROM user_unlocks WHERE user_id = ?").bind(userId).all(),
    env.DB.prepare("SELECT entitlement_id FROM entitlements WHERE user_id = ?").bind(userId).all(),
  ]);
  if (!prof) return 0;
  const have = new Set((owned ?? []).map((r: any) => r.unlock_id));
  const entSet = new Set((ents ?? []).map((r: any) => r.entitlement_id));
  const now = nowSec();
  let granted = 0;
  for (const d of defs ?? []) {
    const id = (d as any).unlock_id as string;
    if (have.has(id)) continue;
    let crit: any;
    try { crit = JSON.parse((d as any).criteria); } catch { continue; }
    let pass = false;
    if (crit.type === "level") pass = (prof.level as number) >= (crit.gte ?? 999);
    else if (crit.type === "stat") pass = ((prof as any)[crit.stat] ?? 0) >= (crit.gte ?? Infinity);
    else if (crit.type === "entitlement") pass = entSet.has(crit.id);
    if (pass) {
      await env.DB.prepare(
        `INSERT INTO user_unlocks (user_id, unlock_id, granted_at, source_event_id)
         VALUES (?, ?, ?, NULL) ON CONFLICT DO NOTHING`).bind(userId, id, now).run();
      granted++;
    }
  }
  return granted;
}
