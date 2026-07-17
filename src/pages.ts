import { Hono } from "hono";
import type { Env } from "./env";
import { nowSec } from "./env";
import type { Auth } from "./auth";
import { generateKidNameClamped, validateChosenName } from "./names";

/**
 * Minimal server-rendered pages so the whole account + device-link loop works end-to-end from
 * day one. The real playcombatforge.com styling can replace these later — every form just talks
 * to the standard Better Auth endpoints, so a prettier front-end is a drop-in.
 *
 * Age-gate posture (COPPA, docs/multiplayer-plan.md §5 + Tom 2026-07-17):
 *  - Neutral birth-year picker. We store only isChild + turns13On (the derived unlock date).
 *  - Under-13: NO email field, name is GENERATED, with a friendly note that they can pick their
 *    own name once they're old enough (rename auto-unlocks on turns13On).
 *  - 13+: choose a username (validated + filtered), optional email later.
 */

type BuildAuthFn = (env: Env) => Auth;

const page = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — CombatForge</title>
<style>
  body{font-family:system-ui,sans-serif;background:#14161a;color:#eee;display:flex;justify-content:center;padding:40px 16px}
  main{max-width:420px;width:100%}
  h1{font-size:1.4rem} a{color:#8ab4ff}
  form{background:#1d2026;padding:20px;border-radius:10px;display:flex;flex-direction:column;gap:10px}
  input,select,button{padding:10px;border-radius:6px;border:1px solid #333;background:#12141a;color:#eee;font-size:1rem}
  button{background:#2a6df4;border:none;cursor:pointer;font-weight:600}
  .note{color:#9aa3b2;font-size:.9rem;line-height:1.35}
  .err{color:#ff7a70;font-weight:600}
  .ok{color:#7ce38b;font-weight:600}
  .code{font-family:monospace;font-size:1.6rem;letter-spacing:.35em;text-align:center}
</style></head><body><main>${body}</main></body></html>`;

export function buildPages(buildAuth: BuildAuthFn) {
  const app = new Hono<{ Bindings: Env }>();

  const env0 = (env: Env) => env.PUBLIC_BASE_URL;

  // ---- helpers: forward form posts as JSON to the stable Better Auth endpoints ----
  const authPost = async (env: Env, path: string, body: unknown, cookie: string | null) => {
    const auth = buildAuth(env);
    // Origin must match trustedOrigins — Better Auth CSRF-checks cookie-authenticated POSTs.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Origin": env.PUBLIC_BASE_URL,
    };
    if (cookie) headers["Cookie"] = cookie;
    return auth.handler(new Request(`${env.PUBLIC_BASE_URL}/api/auth${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
    }));
  };

  const passCookies = (from: Response, to: Response) => {
    const setCookie = from.headers.get("set-cookie");
    if (setCookie) to.headers.set("set-cookie", setCookie);
    return to;
  };

  // ---- signup (age gate first) ----
  app.get("/signup", (c) => {
    const err = c.req.query("err") ?? "";
    const year = new Date().getUTCFullYear();
    const opts = Array.from({ length: 90 }, (_, i) => `<option>${year - i}</option>`).join("");
    return c.html(page("Create account", `
      <h1>Create your CombatForge account</h1>
      ${err ? `<p class="err">${err}</p>` : ""}
      <form method="post" action="/signup">
        <label>Birth year <span class="note">(for account setup only)</span></label>
        <select name="birthYear" required>${opts}</select>
        <label>Pick a player name <span class="note">(3-16 letters/numbers/_; younger players get a fun generated name)</span></label>
        <input name="username" placeholder="player name" maxlength="16">
        <label>Password</label>
        <input name="password" type="password" minlength="8" required>
        <button>Create account</button>
        <p class="note">No email needed. Younger players: we'll pick your name for now —
        you can choose your own when you're old enough!</p>
      </form>
      <p><a href="/login">Already have an account? Log in</a></p>`));
  });

  app.post("/signup", async (c) => {
    const form = await c.req.parseBody();
    const birthYear = Number(form["birthYear"] ?? 0);
    const password = String(form["password"] ?? "");
    const nowYear = new Date().getUTCFullYear();
    if (!birthYear || birthYear < nowYear - 100 || birthYear > nowYear) {
      return c.redirect("/signup?err=" + encodeURIComponent("Pick your birth year."));
    }
    // Neutral age gate: conservative — treat as under 13 until the year they COULD be 13 has passed.
    const age = nowYear - birthYear;
    const isChild = age < 13;

    let username: string;
    if (isChild) {
      username = generateKidNameClamped();
    } else {
      const v = validateChosenName(String(form["username"] ?? ""));
      if (!v.ok) return c.redirect("/signup?err=" + encodeURIComponent(v.reason));
      username = v.name;
    }
    if (password.length < 8) {
      return c.redirect("/signup?err=" + encodeURIComponent("Password must be at least 8 characters."));
    }

    // Zero-contact-info accounts: synthesize a placeholder email to satisfy the core schema.
    const email = `${username.toLowerCase()}@players.playcombatforge.local`;
    const res = await authPost(c.env, "/sign-up/email", {
      email, password, name: username, username, displayUsername: username,
    }, null);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const msg = /USERNAME_IS_ALREADY_TAKEN|already/i.test(detail)
        ? "That name is taken — try another." : "Signup failed — try a different name.";
      return c.redirect("/signup?err=" + encodeURIComponent(msg));
    }

    // Stamp the child flags server-side (additionalFields are input:false — never client-settable).
    if (isChild) {
      const turns13 = `${birthYear + 13}-01-01`; // conservative: unlocks Jan 1 of their 13th year
      await c.env.DB.prepare(
        `UPDATE user SET isChild = 1, turns13On = ? WHERE username = ?`).bind(turns13, username).run();
    }

    const done = c.redirect(isChild ? `/welcome-kid?name=${encodeURIComponent(username)}` : "/link");
    return passCookies(res, done);
  });

  app.get("/welcome-kid", (c) => {
    const name = c.req.query("name") ?? "Player";
    return c.html(page("Welcome!", `
      <h1>Welcome, <span class="ok">${name}</span>! 🎉</h1>
      <p class="note">That's your player name for now. When you're old enough, you'll be able to
      choose your own name — it unlocks automatically on your 13th birthday year.</p>
      <p class="note">Write your name and password down somewhere safe (or have a parent keep it).</p>
      <p><a href="/link">Linking a game? Enter your code here →</a></p>`));
  });

  // ---- login ----
  app.get("/login", (c) => {
    const err = c.req.query("err") ?? "";
    return c.html(page("Log in", `
      <h1>Log in</h1>
      ${err ? `<p class="err">${err}</p>` : ""}
      <form method="post" action="/login">
        <input name="username" placeholder="player name" required maxlength="16">
        <input name="password" type="password" placeholder="password" required>
        <button>Log in</button>
      </form>
      <p><a href="/signup">New here? Create an account</a></p>`));
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const res = await authPost(c.env, "/sign-in/username", {
      username: String(form["username"] ?? ""), password: String(form["password"] ?? ""),
    }, null);
    if (!res.ok) {
      return c.redirect("/login?err=" + encodeURIComponent("Wrong name or password."));
    }
    const next = c.req.query("next") ?? "/link";
    return passCookies(res, c.redirect(next));
  });

  // ---- device link (the game shows a 6-char code; player approves it here) ----
  app.get("/link", async (c) => {
    // Must be logged in to approve — bounce to login and come back.
    const auth = buildAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.redirect("/login?next=" + encodeURIComponent("/link"));
    const err = c.req.query("err") ?? "";
    const okMsg = c.req.query("ok") ?? "";
    return c.html(page("Link your game", `
      <h1>Link your game</h1>
      <p class="note">Start CombatForge, choose <b>LOG IN</b>, and type the 6-character code it
      shows you here.</p>
      ${err ? `<p class="err">${err}</p>` : ""}
      ${okMsg ? `<p class="ok">${okMsg}</p>` : ""}
      <form method="post" action="/link">
        <input class="code" name="userCode" placeholder="ABC123" maxlength="6" required
               autocomplete="off" autocapitalize="characters">
        <button>Approve this game</button>
      </form>`));
  });

  app.post("/link", async (c) => {
    const form = await c.req.parseBody();
    const userCode = String(form["userCode"] ?? "").toUpperCase().trim();
    if (!/^[A-Z2-9]{6}$/.test(userCode)) {
      return c.redirect("/link?err=" + encodeURIComponent("Codes are 6 letters/numbers."));
    }
    const cookie = c.req.header("Cookie") ?? null;
    // Better Auth's device flow (post-GHSA-cq3f hardening) is TWO steps: the signed-in session must
    // first CLAIM the code (GET /device?user_code=) before it may approve it.
    const auth = buildAuth(c.env);
    const claimHeaders: Record<string, string> = { "Origin": env0(c.env) };
    if (cookie) claimHeaders["Cookie"] = cookie;
    const claim = await auth.handler(new Request(
      `${c.env.PUBLIC_BASE_URL}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
      { method: "GET", headers: claimHeaders }));
    if (!claim.ok) {
      return c.redirect("/link?err=" + encodeURIComponent(
        "That code didn't work — check it and make sure the game is still waiting."));
    }
    const res = await authPost(c.env, "/device/approve", { userCode }, cookie);
    if (!res.ok) {
      return c.redirect("/link?err=" + encodeURIComponent(
        "That code didn't work — check it and make sure the game is still waiting."));
    }
    return c.redirect("/link?ok=" + encodeURIComponent("Game linked! Jump back into CombatForge."));
  });

  return app;
}
