import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env";
import { buildAuth } from "./auth";
import { buildPages } from "./pages";
import { serverRoutes, browseRoutes } from "./directory";
import { reportRoutes } from "./reports";
import { casualRoutes } from "./casual";
import { profileRoutes, storeRoutes, adminRoutes } from "./store";

/**
 * combatforge-api — accounts, device-link login, server directory (browser/quickplay/private
 * codes), match-report XP pipeline, store entitlements + promo codes.
 * See combatforge repo docs/multiplayer-plan.md + docs/progression-plan.md for the design.
 *
 * Route map:
 *   /api/auth/*            Better Auth (sign-up/sign-in/session/device flow)
 *   /signup /login /link   minimal server-rendered pages (age-gated; device approval)
 *   /v1/servers/*          fleet endpoints (per-instance server key)
 *   /v1/match-report       fleet endpoint (server key + HMAC) — the ONLY XP entry point
 *   /v1/servers /v1/quickplay /v1/join/:code   client endpoints (session/Bearer auth)
 *   /v1/profile/* /v1/store /v1/promo/*        client endpoints (session/Bearer auth)
 *   /v1/admin/*            provisioning (ADMIN_KEY)
 */

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'none'"],
    connectSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'none'"],
    imgSrc: ["'self'", "data:"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
  },
  referrerPolicy: "no-referrer",
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
  xFrameOptions: "DENY",
  permissionsPolicy: {
    camera: false,
    geolocation: false,
    microphone: false,
  },
}));

app.get("/healthz", (c) => {
  const configured = !!(c.env.DB && c.env.BETTER_AUTH_SECRET?.length >= 32 &&
    c.env.ADMIN_KEY?.length >= 32 && c.env.GAME_CLIENT_ID && c.env.PUBLIC_BASE_URL);
  return c.json({ ok: configured, service: "combatforge-api" }, configured ? 200 : 503);
});

// Better Auth handles everything under /api/auth/* (device flow endpoints included).
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  // Account creation must pass through /signup so the 13+ gate cannot be bypassed by calling the
  // underlying Better Auth endpoint directly.
  if (c.req.method === "POST" && path.includes("/sign-up/")) {
    return c.json({ error: "use /signup to create an account" }, 403);
  }
  // Legacy under-13 accounts are disabled for release. Keep the response generic and do not mint
  // a new session even if a client calls Better Auth directly instead of using the login page.
  if (c.req.method === "POST" && path.endsWith("/sign-in/username")) {
    const body = await c.req.raw.clone().json().catch(() => null) as { username?: string } | null;
    const username = body?.username?.trim() ?? "";
    if (username) {
      const restricted = await c.env.DB.prepare(
        `SELECT isChild FROM user WHERE username = ? COLLATE NOCASE`).bind(username).first();
      if (restricted?.isChild) return c.json({ error: "account unavailable" }, 403);
    }
  }
  return buildAuth(c.env).handler(c.req.raw);
});

// Human-facing pages (age-gated signup, login, device-link approval).
app.route("/", buildPages(buildAuth));

// Fleet endpoints (per-server key auth inside).
app.route("/v1/servers", serverRoutes);
app.route("/v1", reportRoutes);

// Provisioning (ADMIN_KEY) — MUST mount before the session-gated client sub-app: Hono runs the
// client router's use("*") middleware for any /v1/* path registered after it, which would 401
// admin calls before they ever reach the admin router.
app.route("/v1/admin", adminRoutes);

// Client endpoints: require a session (cookie or Authorization: Bearer via the bearer plugin).
// Accounts are REQUIRED for all online play (Tom 2026-07-17) — every listed/matchmade join
// goes through here; LAN/direct-IP play stays outside this API entirely.
const requireSession = async (c: any, next: () => Promise<void>) => {
  const auth = buildAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "sign in required" }, 401);
  const user = await c.env.DB.prepare(`SELECT isChild FROM user WHERE id = ?`)
    .bind(session.user.id).first();
  if (user?.isChild) return c.json({ error: "account unavailable", code: "AGE_RESTRICTED" }, 403);
  c.set("userId", session.user.id);
  await next();
};

const client = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
client.use("*", requireSession);
client.route("/", browseRoutes);
client.route("/", profileRoutes);
client.route("/", storeRoutes);
client.route("/", casualRoutes);   // /v1/casual-report — honor-system XP for local/listen/offline matches
app.route("/v1", client);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
