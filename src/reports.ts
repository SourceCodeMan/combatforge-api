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
  if (new TextEncoder().encode(rawBody).byteLength > 256 * 1024) {
    return c.json({ error: "report too large" }, 413);
  }
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
  const hasControls = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);
  if (!report || typeof report !== "object" || !report.matchId ||
      typeof report.matchId !== "string" || report.matchId.length > 64 ||
      hasControls(report.matchId)) {
    return c.json({ error: "bad matchId" }, 400);
  }
  if (!Array.isArray(report.players) || report.players.length === 0 || report.players.length > 12) {
    return c.json({ error: "bad roster" }, 400);
  }
  if (!Number.isInteger(report.durationSec) || report.durationSec < 30 ||
      report.durationSec > 3 * 60 * 60) {
    return c.json({ error: "implausible duration" }, 400);
  }
  if (typeof report.mode !== "string" || !report.mode || report.mode.length > 64 || hasControls(report.mode) ||
      typeof report.map !== "string" || !report.map || report.map.length > 64 || hasControls(report.map) ||
      (report.arenaId !== undefined && (typeof report.arenaId !== "string" ||
        report.arenaId.length > 128 || hasControls(report.arenaId)))) {
    return c.json({ error: "bad match metadata" }, 400);
  }
  if (!Number.isInteger(report.endedAt) || report.endedAt <= 0 ||
      (report.startedAt !== undefined && (!Number.isInteger(report.startedAt) ||
        report.startedAt <= 0 || report.startedAt > report.endedAt)) ||
      !Number.isInteger(report.netProtocol) || report.netProtocol < 1 || report.netProtocol > 1_000_000 ||
      ![0, 1, 255].includes(report.winnerTeam)) {
    return c.json({ error: "bad match metadata" }, 400);
  }

  const validStat = (value: unknown, max = 1_000_000): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const seenGuids = new Set<string>();
  const seenExplicitUsers = new Set<string>();
  for (const p of report.players) {
    if (!p || typeof p !== "object" || typeof p.guidHash !== "string" ||
        !/^[0-9a-f]{40}$/.test(p.guidHash) || seenGuids.has(p.guidHash)) {
      return c.json({ error: "bad or duplicate player identity" }, 400);
    }
    seenGuids.add(p.guidHash);
    if (p.userId !== undefined && (typeof p.userId !== "string" || !p.userId || p.userId.length > 128)) {
      return c.json({ error: "bad player account" }, 400);
    }
    if (p.userId && !p.isBot) {
      if (seenExplicitUsers.has(p.userId)) return c.json({ error: "duplicate player account" }, 400);
      seenExplicitUsers.add(p.userId);
    }
    if (![0, 1, 255].includes(p.team) || !validStat(p.elims, 10_000) ||
        !validStat(p.timesElim, 10_000) || !validStat(p.score) || !validStat(p.tags, 10_000) ||
        !validStat(p.objective, 10_000) || !validStat(p.builder, 100_000) ||
        typeof p.completed !== "boolean" || (p.isBot !== undefined && typeof p.isBot !== "boolean")) {
      return c.json({ error: "bad player stats" }, 400);
    }
  }

  type Resolved = { player: MatchReport["players"][number]; userId: string | null };
  const resolved: Resolved[] = [];
  const resolvedUsers = new Set<string>();
  for (const player of report.players) {
    const link = await c.env.DB.prepare(
      `SELECT user_id FROM identities WHERE guid_hash = ?`).bind(player.guidHash).first();
    if (player.userId && link?.user_id && link.user_id !== player.userId) {
      return c.json({ error: "player identity/account mismatch" }, 409);
    }
    let userId = player.isBot ? null : (player.userId ?? (link?.user_id as string | undefined) ?? null);
    if (userId) {
      const account = await c.env.DB.prepare(`SELECT id, isChild FROM user WHERE id = ?`).bind(userId).first();
      if (!account || account.isChild) userId = null;
    }
    if (userId && resolvedUsers.has(userId)) {
      return c.json({ error: "multiple roster entries resolve to one account" }, 400);
    }
    if (userId) resolvedUsers.add(userId);
    resolved.push({ player, userId });
  }

  const now = nowSec();
  const dayStart = Math.floor(now / 86400) * 86400;
  const processingToken = crypto.randomUUID();
  const ownsMatch = `EXISTS (
    SELECT 1 FROM matches
    WHERE match_id = ? AND processing_token = ? AND processed_at IS NULL)`;
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO matches (match_id, server_id, mode, map, arena_id, started_at, ended_at,
         duration_sec, winner_team, net_protocol, raw, processing_token, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(match_id) DO NOTHING`)
      .bind(report.matchId, server.server_id as string, report.mode, report.map,
        report.arenaId ?? null, report.startedAt ?? null, report.endedAt,
        report.durationSec, report.winnerTeam, report.netProtocol, rawBody, processingToken),
    c.env.DB.prepare(
      `UPDATE matches SET processing_token = ?
       WHERE match_id = ? AND processed_at IS NULL AND processing_token IS NULL`)
      .bind(processingToken, report.matchId),
  ];

  const grantedUsers: string[] = [];
  for (const { player: p, userId } of resolved) {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO match_players (match_id, user_id, guid_hash, team, elims, times_elim, score,
         tags, objective, builder, completed, is_bot)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ownsMatch}
       ON CONFLICT(match_id, guid_hash) DO NOTHING`)
      .bind(report.matchId, userId, p.guidHash, p.team, p.elims, p.timesElim, p.score,
        p.tags, p.objective, p.builder, p.completed ? 1 : 0, p.isBot ? 1 : 0,
        report.matchId, processingToken));

    if (!userId || p.isBot) continue;
    const stats: PlayerStats = {
      elims: p.elims,
      tags: p.tags,
      objective: p.objective,
      builder: p.builder,
      completed: p.completed,
      won: report.winnerTeam !== 255 && p.team === report.winnerTeam,
    };

    if (stats.completed) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO daily_bonus_claims (user_id, day_start, match_id, created_at)
         SELECT ?, ?, ?, ? WHERE ${ownsMatch}
         ON CONFLICT(user_id, day_start) DO NOTHING`)
        .bind(userId, dayStart, report.matchId, now, report.matchId, processingToken));
    }

    for (const event of computeXpEvents(stats, false)) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO xp_events (user_id, match_id, source, amount, rule_version, meta, created_at)
         SELECT ?, ?, ?, ?, ?, '{}', ? WHERE ${ownsMatch}
         ON CONFLICT(match_id, user_id, source) DO NOTHING`)
        .bind(userId, report.matchId, event.source, event.amount, RULE_VERSION, now,
          report.matchId, processingToken));
    }
    if (stats.completed) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO xp_events (user_id, match_id, source, amount, rule_version, meta, created_at)
         SELECT ?, ?, 'daily', 250, ?, '{}', ?
         WHERE ${ownsMatch} AND EXISTS (
           SELECT 1 FROM daily_bonus_claims WHERE user_id = ? AND day_start = ? AND match_id = ?)
         ON CONFLICT(match_id, user_id, source) DO NOTHING`)
        .bind(userId, report.matchId, RULE_VERSION, now, report.matchId, processingToken,
          userId, dayStart, report.matchId));
    }

    // Derive the projection delta from the ledger rows that this same transaction inserted. This
    // prevents the projection from diverging when a ledger write is deduplicated.
    stmts.push(c.env.DB.prepare(
      `INSERT INTO app_profiles (user_id, xp_total, playtime_sec, matches_played, wins,
         eliminations, times_eliminated, tags, builder, updated_at)
       SELECT ?, COALESCE((
         SELECT SUM(amount) FROM xp_events WHERE user_id = ? AND match_id = ?), 0),
         ?, 1, ?, ?, ?, ?, ?, ?
       WHERE ${ownsMatch}
       ON CONFLICT(user_id) DO UPDATE SET
         xp_total = xp_total + excluded.xp_total,
         playtime_sec = playtime_sec + excluded.playtime_sec,
         matches_played = matches_played + 1,
         wins = wins + excluded.wins,
         eliminations = eliminations + excluded.eliminations,
         times_eliminated = times_eliminated + excluded.times_eliminated,
         tags = tags + excluded.tags,
         builder = builder + excluded.builder,
         updated_at = excluded.updated_at`)
      .bind(userId, userId, report.matchId, report.durationSec, stats.won ? 1 : 0,
        stats.elims, p.timesElim, stats.tags, stats.builder, now, report.matchId, processingToken));
    grantedUsers.push(userId);
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE matches SET processed_at = ?, processing_token = NULL
     WHERE match_id = ? AND processing_token = ? AND processed_at IS NULL`)
    .bind(now, report.matchId, processingToken));

  const results = await c.env.DB.batch(stmts);
  const owned = (results[0]?.meta?.changes ?? 0) > 0 || (results[1]?.meta?.changes ?? 0) > 0;
  if (!owned) return c.json({ ok: true, duplicate: true });

  // The ledger and projection are already committed atomically. Level/unlock projections are
  // rebuildable; log a failure without causing a retry to misreport the committed match as failed.
  for (const userId of grantedUsers) {
    try {
      const prof = await c.env.DB.prepare(
        "SELECT xp_total, level FROM app_profiles WHERE user_id = ?").bind(userId).first();
      if (!prof) continue;
      const newLevel = levelForXp(prof.xp_total as number);
      if (newLevel !== prof.level) {
        await c.env.DB.prepare("UPDATE app_profiles SET level = ? WHERE user_id = ?")
          .bind(newLevel, userId).run();
      }
      await evaluateUnlocks(c.env, userId);
    } catch (error) {
      console.error("post-match projection failed", { userId, error: String(error) });
    }
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
