import { Hono } from "hono";
import type { Env } from "./env";
import { nowSec } from "./env";
import { levelProgress } from "./xp";
import { evaluateUnlocks } from "./reports";

/**
 * Client-facing profile + store (session-authenticated by index.ts middleware).
 * The in-game STORE MENU is a SHOWCASE: it lists unlocks + pack SKUs and points at the website
 * for checkout — no card entry in the client, ever (FTC dark-patterns lesson; kids audience).
 * Purchases land as `entitlements` rows (via merchant-of-record webhook later, or promo codes /
 * admin grants today) and the criteria {"type":"entitlement","id":"all_access"} unlock defs
 * light up on the next evaluation.
 */

type Vars = { userId: string };

export const profileRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

profileRoutes.get("/profile/me", async (c) => {
  const userId = c.get("userId");
  const [prof, user, { results: unlocks }, { results: ents }] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM app_profiles WHERE user_id = ?").bind(userId).first(),
    c.env.DB.prepare(
      `SELECT name, username, displayUsername, isChild, turns13On FROM user WHERE id = ?`).bind(userId).first(),
    c.env.DB.prepare("SELECT unlock_id FROM user_unlocks WHERE user_id = ?").bind(userId).all(),
    c.env.DB.prepare("SELECT entitlement_id FROM entitlements WHERE user_id = ?").bind(userId).all(),
  ]);
  const xpTotal = (prof?.xp_total as number) ?? 0;
  return c.json({
    userId,
    // displayUsername preserves the case the player chose; username is the lowercased unique key.
    displayName: (user?.displayUsername as string) ?? (user?.username as string) ?? (user?.name as string) ?? "Player",
    isChild: !!(user?.isChild),
    turns13On: (user?.turns13On as string) ?? null,
    xpTotal,
    progress: levelProgress(xpTotal),
    stats: {
      playtimeSec: (prof?.playtime_sec as number) ?? 0,
      matches: (prof?.matches_played as number) ?? 0,
      wins: (prof?.wins as number) ?? 0,
      eliminations: (prof?.eliminations as number) ?? 0,
      timesEliminated: (prof?.times_eliminated as number) ?? 0,
      tags: (prof?.tags as number) ?? 0,
    },
    unlocks: (unlocks ?? []).map((r: any) => r.unlock_id),
    entitlements: (ents ?? []).map((r: any) => r.entitlement_id),
  });
});

/** Link this install's GUID hash to the logged-in account (retroactive history attach). */
profileRoutes.post("/identities/link", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ guidHash: string }>().catch(() => null);
  const guidHash = body?.guidHash?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(guidHash)) return c.json({ error: "bad guidHash" }, 400);
  const now = nowSec();
  await c.env.DB.prepare(
    `INSERT INTO identities (guid_hash, user_id, linked_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guid_hash) DO UPDATE SET user_id = excluded.user_id, last_seen_at = excluded.last_seen_at`)
    .bind(guidHash, userId, now, now).run();
  // Retro-attach any recorded matches from before the account existed.
  await c.env.DB.prepare(
    "UPDATE match_players SET user_id = ? WHERE guid_hash = ? AND user_id IS NULL")
    .bind(userId, guidHash).run();
  return c.json({ ok: true });
});

export const storeRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Store showcase: all active unlocks + pack SKUs + what this account already owns. */
storeRoutes.get("/store", async (c) => {
  const userId = c.get("userId");
  const [{ results: defs }, { results: owned }, { results: ents }] = await Promise.all([
    c.env.DB.prepare(
      "SELECT unlock_id, kind, criteria, payload, sort FROM unlock_definitions WHERE active = 1 ORDER BY sort").all(),
    c.env.DB.prepare("SELECT unlock_id FROM user_unlocks WHERE user_id = ?").bind(userId).all(),
    c.env.DB.prepare("SELECT entitlement_id FROM entitlements WHERE user_id = ?").bind(userId).all(),
  ]);
  const ownedSet = new Set((owned ?? []).map((r: any) => r.unlock_id));
  return c.json({
    packs: [
      {
        sku: "all_access",
        title: "All-Access Pack",
        description: "Unlocks every cosmetic — current and future.",
        owned: (ents ?? []).some((r: any) => r.entitlement_id === "all_access"),
        // Checkout happens on the WEBSITE (merchant of record) — the game only shows this URL.
        checkoutUrl: "https://playcombatforge.com/store/all-access",
      },
    ],
    unlocks: (defs ?? []).map((d: any) => ({
      id: d.unlock_id,
      kind: d.kind,
      criteria: JSON.parse(d.criteria),
      payload: JSON.parse(d.payload),
      owned: ownedSet.has(d.unlock_id),
    })),
  });
});

/** Redeem a promo code (Tom's comps: codes grant entitlements, e.g. the All-Access pack). */
storeRoutes.post("/promo/redeem", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ code: string }>().catch(() => null);
  const code = body?.code?.toUpperCase().trim() ?? "";
  if (!/^[A-Z2-9-]{4,24}$/.test(code)) return c.json({ error: "bad code" }, 400);
  const promo = await c.env.DB.prepare(
    "SELECT entitlement_id, max_uses, uses, expires_at FROM promo_codes WHERE code = ?")
    .bind(code).first();
  if (!promo) return c.json({ error: "unknown code" }, 404);
  if (promo.expires_at && (promo.expires_at as number) < nowSec()) {
    return c.json({ error: "code expired" }, 410);
  }
  // Atomic use-count claim: the WHERE clause makes double-spends impossible.
  const claim = await c.env.DB.prepare(
    "UPDATE promo_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses")
    .bind(code).run();
  if ((claim.meta?.changes ?? 0) === 0) return c.json({ error: "code fully used" }, 410);
  await c.env.DB.prepare(
    `INSERT INTO entitlements (user_id, entitlement_id, granted_at, source)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(userId, promo.entitlement_id as string, nowSec(), `promo:${code}`).run();
  const granted = await evaluateUnlocks(c.env, userId);
  return c.json({ ok: true, entitlement: promo.entitlement_id, unlocksGranted: granted });
});

// ---- admin provisioning (ADMIN_KEY bearer): server keys + promo codes ----------------------

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", async (c, next) => {
  const authz = c.req.header("Authorization") ?? "";
  if (!c.env.ADMIN_KEY || authz !== `Bearer ${c.env.ADMIN_KEY}`) {
    return c.json({ error: "admin key required" }, 403);
  }
  await next();
});

/** Provision a fleet instance: returns the ONE-TIME plaintext key (only the hash is stored). */
adminRoutes.post("/servers", async (c) => {
  const body = await c.req.json<{ name: string; region?: string }>().catch(() => null);
  if (!body?.name) return c.json({ error: "name required" }, 400);
  const serverId = crypto.randomUUID();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = [...keyBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { sha256Hex } = await import("./hmac");
  await c.env.DB.prepare(
    "INSERT INTO game_servers (server_id, name, key_hash, region, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .bind(serverId, body.name, await sha256Hex(key), body.region ?? "us-east", nowSec()).run();
  return c.json({ serverId, key, note: "Store this key on the fleet box — it is shown exactly once." });
});

adminRoutes.post("/promo", async (c) => {
  const body = await c.req.json<{
    code?: string; entitlementId: string; maxUses?: number; expiresAt?: number; note?: string;
  }>().catch(() => null);
  if (!body?.entitlementId) return c.json({ error: "entitlementId required" }, 400);
  let code = body.code?.toUpperCase();
  if (!code) {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  }
  await c.env.DB.prepare(
    "INSERT INTO promo_codes (code, entitlement_id, max_uses, uses, expires_at, created_at, note) VALUES (?, ?, ?, 0, ?, ?, ?)")
    .bind(code, body.entitlementId, body.maxUses ?? 1, body.expiresAt ?? null, nowSec(), body.note ?? null).run();
  return c.json({ ok: true, code });
});
