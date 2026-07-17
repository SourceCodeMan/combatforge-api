import { Hono } from "hono";
import type { Env, } from "./env";
import { nowSec } from "./env";
import { sha256Hex } from "./hmac";

/**
 * Dedicated-fleet directory (docs/multiplayer-plan.md §4):
 *  - fleet instances authenticate with a per-instance secret (Authorization: Bearer <key>,
 *    stored as SHA-256 in game_servers.key_hash — provisioned via /v1/admin/servers)
 *  - register at boot, heartbeat every ~10s; 30s without a beat = hidden from every list
 *  - clients (session-authenticated) browse / quick-play / join private matches by 6-char code
 * D1 is comfortably sufficient at fleet scale (~1.2 writes/s worst case); swap to a Durable
 * Object only if listing consistency ever becomes a real problem.
 */

export const STALE_AFTER_SEC = 30;

type Vars = { userId: string };

// ---- fleet-side (server-key auth) ----------------------------------------------------------

export const serverRoutes = new Hono<{ Bindings: Env }>();

async function authServer(c: any): Promise<{ serverId: string } | Response> {
  const authz = c.req.header("Authorization") ?? "";
  const key = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!key) return c.json({ error: "missing server key" }, 401);
  const keyHash = await sha256Hex(key);
  const row = await c.env.DB.prepare(
    "SELECT server_id FROM game_servers WHERE key_hash = ? AND active = 1").bind(keyHash).first();
  if (!row) return c.json({ error: "unknown server key" }, 403);
  return { serverId: row.server_id as string };
}

serverRoutes.post("/register", async (c) => {
  const auth = await authServer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json<{
    port: number; lanAddr?: string; map?: string; mode?: string; format?: string;
    maxPlayers?: number; netProtocol: number; private?: boolean;
  }>();
  if (!body?.port || typeof body.netProtocol !== "number") {
    return c.json({ error: "port + netProtocol required" }, 400);
  }
  // Join address = the IP the Worker OBSERVED (spoof-proof); port is self-reported.
  const observedIp = c.req.header("CF-Connecting-IP") ?? "0.0.0.0";
  const isPrivate = body.private === true;
  // Private matches get a 6-char join code (unambiguous alphabet — read aloud between friends).
  let joinCode: string | null = null;
  if (isPrivate) {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    joinCode = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  }
  await c.env.DB.prepare(
    `INSERT INTO server_status (server_id, addr, lan_addr, port, map, mode, format, phase, players,
       max_players, net_protocol, private, join_code, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Lobby', 0, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET addr=excluded.addr, lan_addr=excluded.lan_addr,
       port=excluded.port, map=excluded.map, mode=excluded.mode, format=excluded.format,
       max_players=excluded.max_players, net_protocol=excluded.net_protocol,
       private=excluded.private, join_code=excluded.join_code, last_seen_at=excluded.last_seen_at`)
    .bind(auth.serverId, observedIp, body.lanAddr ?? null, body.port, body.map ?? "", body.mode ?? "",
      body.format ?? "", body.maxPlayers ?? 12, body.netProtocol, isPrivate ? 1 : 0, joinCode, nowSec())
    .run();
  return c.json({ ok: true, serverId: auth.serverId, joinCode });
});

serverRoutes.post("/heartbeat", async (c) => {
  const auth = await authServer(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json<{
    players: number; phase?: string; map?: string; mode?: string; format?: string;
  }>();
  const res = await c.env.DB.prepare(
    `UPDATE server_status SET players = ?, phase = COALESCE(?, phase), map = COALESCE(?, map),
       mode = COALESCE(?, mode), format = COALESCE(?, format), last_seen_at = ?
     WHERE server_id = ?`)
    .bind(body.players ?? 0, body.phase ?? null, body.map ?? null, body.mode ?? null,
      body.format ?? null, nowSec(), auth.serverId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    return c.json({ error: "not registered — call /register first" }, 409);
  }
  return c.json({ ok: true });
});

serverRoutes.post("/unregister", async (c) => {
  const auth = await authServer(c);
  if (auth instanceof Response) return auth;
  await c.env.DB.prepare("DELETE FROM server_status WHERE server_id = ?").bind(auth.serverId).run();
  return c.json({ ok: true });
});

// ---- client-side (session auth applied by index.ts middleware) -----------------------------

export const browseRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const PUBLIC_LIST_SQL = `
  SELECT s.server_id, g.name, s.addr, s.lan_addr, s.port, s.map, s.mode, s.format, s.phase,
         s.players, s.max_players, s.net_protocol
  FROM server_status s JOIN game_servers g ON g.server_id = s.server_id
  WHERE s.private = 0 AND g.active = 1 AND s.last_seen_at >= ?`;

browseRoutes.get("/servers", async (c) => {
  const cutoff = nowSec() - STALE_AFTER_SEC;
  const { results } = await c.env.DB.prepare(
    PUBLIC_LIST_SQL + " ORDER BY s.players DESC, g.name").bind(cutoff).all();
  return c.json({ servers: results });
});

// Quick-play: fullest non-full compatible server — concentrates a small population.
browseRoutes.get("/quickplay", async (c) => {
  const netProtocol = Number(c.req.query("netProtocol") ?? "0");
  const cutoff = nowSec() - STALE_AFTER_SEC;
  const row = await c.env.DB.prepare(
    PUBLIC_LIST_SQL + ` AND s.net_protocol = ? AND s.players < s.max_players
     ORDER BY s.players DESC LIMIT 1`).bind(cutoff, netProtocol).first();
  if (!row) return c.json({ error: "no open servers" }, 404);
  return c.json({ server: row });
});

browseRoutes.get("/join/:code", async (c) => {
  const code = c.req.param("code").toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return c.json({ error: "bad code" }, 400);
  const cutoff = nowSec() - STALE_AFTER_SEC;
  const row = await c.env.DB.prepare(
    `SELECT s.server_id, g.name, s.addr, s.lan_addr, s.port, s.net_protocol, s.players, s.max_players
     FROM server_status s JOIN game_servers g ON g.server_id = s.server_id
     WHERE s.join_code = ? AND s.last_seen_at >= ? AND g.active = 1`).bind(code, cutoff).first();
  if (!row) return c.json({ error: "no match with that code" }, 404);
  return c.json({ server: row });
});
