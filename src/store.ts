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

const parseStoredJson = (raw: unknown): unknown | null => {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

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
      builder: (prof?.builder as number) ?? 0,
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
  const claimed = await c.env.DB.prepare(
    `INSERT INTO identities (guid_hash, user_id, linked_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guid_hash) DO NOTHING`)
    .bind(guidHash, userId, now, now).run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare(
      `SELECT user_id FROM identities WHERE guid_hash = ?`).bind(guidHash).first();
    if (existing?.user_id !== userId) {
      return c.json({ error: "identity already linked to another account" }, 409);
    }
    await c.env.DB.prepare(
      `UPDATE identities SET last_seen_at = ? WHERE guid_hash = ? AND user_id = ?`)
      .bind(now, guidHash, userId).run();
  }
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
  const unlocks = (defs ?? []).flatMap((d: any) => {
    const criteria = parseStoredJson(d.criteria);
    const payload = parseStoredJson(d.payload);
    if (!criteria || !payload) return [];
    return [{
      id: d.unlock_id,
      kind: d.kind,
      criteria,
      payload,
      owned: ownedSet.has(d.unlock_id),
    }];
  });
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
    unlocks,
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
  const now = nowSec();
  if (promo.expires_at && (promo.expires_at as number) < now) {
    return c.json({ error: "code expired" }, 410);
  }
  const entitlementId = promo.entitlement_id as string;
  const owned = await c.env.DB.prepare(
    `SELECT 1 FROM entitlements WHERE user_id = ? AND entitlement_id = ?`)
    .bind(userId, entitlementId).first();
  if (owned) {
    return c.json({ ok: true, entitlement: entitlementId, alreadyOwned: true, unlocksGranted: 0 });
  }

  // One transactional batch owns the redemption, consumes one use, and grants the entitlement.
  // claim_token makes the latter statements no-ops when this user retries a code they already used.
  const claimToken = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO promo_redemptions
         (code, user_id, entitlement_id, redeemed_at, claim_token)
       SELECT code, ?, entitlement_id, ?, ? FROM promo_codes
       WHERE code = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at >= ?)
         AND NOT EXISTS (
           SELECT 1 FROM entitlements WHERE user_id = ? AND entitlement_id = promo_codes.entitlement_id)
       ON CONFLICT(code, user_id) DO NOTHING`)
      .bind(userId, now, claimToken, code, now, userId),
    c.env.DB.prepare(
      `UPDATE promo_codes SET uses = uses + 1
       WHERE code = ? AND EXISTS (
         SELECT 1 FROM promo_redemptions WHERE code = ? AND user_id = ? AND claim_token = ?)`)
      .bind(code, code, userId, claimToken),
    c.env.DB.prepare(
      `INSERT INTO entitlements (user_id, entitlement_id, granted_at, source)
       SELECT user_id, entitlement_id, redeemed_at, 'promo:' || code
       FROM promo_redemptions WHERE code = ? AND user_id = ? AND claim_token = ?
       ON CONFLICT(user_id, entitlement_id) DO NOTHING`)
      .bind(code, userId, claimToken),
  ]);

  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const prior = await c.env.DB.prepare(
      `SELECT entitlement_id FROM promo_redemptions WHERE code = ? AND user_id = ?`)
      .bind(code, userId).first();
    if (prior) {
      return c.json({ ok: true, entitlement: prior.entitlement_id, alreadyRedeemed: true, unlocksGranted: 0 });
    }
    const nowOwned = await c.env.DB.prepare(
      `SELECT 1 FROM entitlements WHERE user_id = ? AND entitlement_id = ?`)
      .bind(userId, entitlementId).first();
    if (nowOwned) {
      return c.json({ ok: true, entitlement: entitlementId, alreadyOwned: true, unlocksGranted: 0 });
    }
    return c.json({ error: "code fully used" }, 410);
  }
  const granted = await evaluateUnlocks(c.env, userId);
  return c.json({ ok: true, entitlement: entitlementId, unlocksGranted: granted });
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
  const name = body?.name?.trim() ?? "";
  const region = body?.region?.trim() || "us-east";
  if (!name || name.length > 80) return c.json({ error: "name must be 1-80 characters" }, 400);
  if (!/^[a-z0-9-]{2,32}$/i.test(region)) return c.json({ error: "bad region" }, 400);
  const serverId = crypto.randomUUID();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = [...keyBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { sha256Hex } = await import("./hmac");
  await c.env.DB.prepare(
    "INSERT INTO game_servers (server_id, name, key_hash, region, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .bind(serverId, name, await sha256Hex(key), region, nowSec()).run();
  return c.json({ serverId, key, note: "Store this key on the fleet box — it is shown exactly once." });
});

adminRoutes.post("/promo", async (c) => {
  const body = await c.req.json<{
    code?: string; entitlementId: string; maxUses?: number; expiresAt?: number; note?: string;
  }>().catch(() => null);
  const entitlementId = body?.entitlementId?.trim() ?? "";
  const maxUses = body?.maxUses ?? 1;
  const expiresAt = body?.expiresAt ?? null;
  const note = body?.note?.trim() || null;
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/i.test(entitlementId)) {
    return c.json({ error: "bad entitlementId" }, 400);
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000) {
    return c.json({ error: "maxUses must be an integer from 1 to 100000" }, 400);
  }
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= nowSec())) {
    return c.json({ error: "expiresAt must be a future unix timestamp" }, 400);
  }
  if (note && note.length > 500) return c.json({ error: "note too long" }, 400);
  let code = body?.code?.toUpperCase().trim();
  if (!code) {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  }
  if (!/^[A-Z2-9-]{4,24}$/.test(code)) return c.json({ error: "bad code" }, 400);
  const inserted = await c.env.DB.prepare(
    `INSERT INTO promo_codes
       (code, entitlement_id, max_uses, uses, expires_at, created_at, note)
     VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(code) DO NOTHING`)
    .bind(code, entitlementId, maxUses, expiresAt, nowSec(), note).run();
  if ((inserted.meta?.changes ?? 0) === 0) return c.json({ error: "code already exists" }, 409);
  return c.json({ ok: true, code });
});
