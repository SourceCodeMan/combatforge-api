import { Hono } from "hono";
import type { Env } from "./env";
import { nowSec } from "./env";
import type { Auth } from "./auth";
import { validateChosenName } from "./names";
import { levelProgress } from "./xp";

/**
 * Minimal server-rendered pages so the whole account + device-link loop works end-to-end from
 * day one. The real playcombatforge.com styling can replace these later — every form just talks
 * to the standard Better Auth endpoints, so a prettier front-end is a drop-in.
 *
 * Release posture: accounts are 13+ only. The signup form uses a neutral birth-date gate, rejects
 * under-13 requests before Better Auth is called, and never stores the submitted birth date.
 */

type BuildAuthFn = (env: Env) => Auth;

export const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — CombatForge</title>
<style>
  body{font-family:system-ui,sans-serif;background:#14161a;color:#eee;display:flex;justify-content:center;padding:40px 16px}
  main{max-width:420px;width:100%}
  h1{font-size:1.4rem} a{color:#8ab4ff}
  form{background:#1d2026;padding:20px;border-radius:10px;display:flex;flex-direction:column;gap:10px}
  input,select,button{padding:10px;border-radius:6px;border:1px solid #333;background:#12141a;color:#eee;font-size:1rem}
  button{background:#2a6df4;border:none;cursor:pointer;font-weight:600}
  button.secondary{background:#2a2f3a}
  button.secondary:hover{background:#343a47}
  .btn-link{display:block;text-align:center;padding:10px;border-radius:6px;background:#2a2f3a;
    color:#eee;text-decoration:none;font-weight:600;margin-top:4px}
  .btn-link:hover{background:#343a47}
  .account-box{background:#1d2026;border:1px solid #333;border-radius:10px;padding:16px 18px;
    margin:14px 0;line-height:1.5;font-size:.95rem}
  .divider{text-align:center;color:#6b7280;font-size:.85rem;margin:4px 0}
  .note{color:#9aa3b2;font-size:.9rem;line-height:1.35}
  /* account dashboard */
  .level-card{display:flex;align-items:center;gap:16px;background:#1d2026;border:1px solid #333;
    border-radius:12px;padding:16px 18px;margin:16px 0}
  .level-badge{flex:none;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;
    justify-content:center;font-family:'Oswald','Arial Narrow',sans-serif;font-weight:700;
    font-size:1.5rem;color:#140a03;background:linear-gradient(135deg,#ffb03a,#ff6a1a)}
  .level-body{flex:1;min-width:0}
  .level-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}
  .xp-num{color:#9aa3b2;font-size:.85rem}
  .xp-bar{height:9px;border-radius:5px;background:#12141a;overflow:hidden}
  .xp-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#ffb03a,#ff6a1a)}
  .level-sub{color:#9aa3b2;font-size:.8rem;margin-top:6px}
  .stat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:16px 0}
  .stat{background:#1d2026;border:1px solid #2b2f38;border-radius:9px;padding:12px 10px;text-align:center}
  .stat-v{font-family:'Oswald','Arial Narrow',sans-serif;font-weight:700;font-size:1.25rem;color:#eee}
  .stat-l{color:#8b95a2;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
  .err{color:#ff7a70;font-weight:600}
  .ok{color:#7ce38b;font-weight:600}
  .code{font-family:monospace;font-size:1.6rem;letter-spacing:.35em;text-align:center}
  footer{margin-top:24px;padding-top:16px;border-top:1px solid #2b2f38;color:#9aa3b2;font-size:.8rem}
  footer a{margin-right:12px}
</style></head><body><main>${body}<footer>
  <a href="https://playcombatforge.com/privacy.html">Privacy</a>
  <a href="https://playcombatforge.com/eula.html">EULA</a>
  <a href="https://playcombatforge.com/early-access-faq.html">Early Access FAQ</a>
</footer></main></body></html>`;

export function buildPages(buildAuth: BuildAuthFn) {
  const app = new Hono<{ Bindings: Env }>();

  const env0 = (env: Env) => env.PUBLIC_BASE_URL;

  // `next` is attacker-influenceable (a crafted link's query string) — constrain it to a same-site
  // relative path so it can never become an open redirect to an external phishing page.
  // Default destination is the account home, NOT /link: only the in-game device-code flow passes
  // an explicit next=/link, so a plain "Log In" from the website lands on the account page instead
  // of the (now-confusing) code-entry screen (Tom 2026-07-17).
  const safeNext = (raw: string | undefined): string => {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") ||
        raw.includes("://") || /[\u0000-\u001f\u007f]/.test(raw)) {
      return "/account";
    }
    return raw;
  };

  const parseBirthDate = (raw: unknown): Date | null => {
    const value = String(raw ?? "");
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) return null;
    return date;
  };

  const ageCutoff = (now: Date): Date =>
    new Date(Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate()));

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
  // `next` threads through login<->signup<->link so a brand-new player who arrives via a device
  // code (/link?user_code=ABC123 -> /login?next=... -> here) lands back exactly where they started,
  // code and all — no retyping it after creating the account.
  app.get("/signup", (c) => {
    const err = c.req.query("err") ?? "";
    const next = safeNext(c.req.query("next"));
    const now = new Date();
    const maxBirthDate = ageCutoff(now).toISOString().slice(0, 10);
    const minBirthDate = new Date(Date.UTC(now.getUTCFullYear() - 100, now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);
    return c.html(page("Create account", `
      <h1>Create your CombatForge account</h1>
      ${err ? `<p class="err">${escapeHtml(err)}</p>` : ""}
      <form method="post" action="/signup?next=${encodeURIComponent(next)}">
        <label>Date of birth <span class="note">(age check only; it is not stored)</span></label>
        <input name="birthDate" type="date" min="${minBirthDate}" max="${maxBirthDate}" required>
        <label>Pick a player name <span class="note">(3-16 letters/numbers/_)</span></label>
        <input name="username" placeholder="player name" maxlength="16" required>
        <label>Password</label>
        <input name="password" type="password" minlength="8" required>
        <button>Create account</button>
        <p class="note">No email needed. CombatForge accounts are currently available to players age 13 and older.</p>
      </form>
      <p><a href="/login?next=${encodeURIComponent(next)}">Already have an account? Log in</a></p>`));
  });

  app.post("/signup", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(c.req.query("next"));
    const birthDate = parseBirthDate(form["birthDate"]);
    const password = String(form["password"] ?? "");
    const now = new Date();
    const oldestAllowed = new Date(Date.UTC(now.getUTCFullYear() - 100, now.getUTCMonth(), now.getUTCDate()));
    if (!birthDate || birthDate < oldestAllowed || birthDate > now) {
      return c.redirect("/signup?next=" + encodeURIComponent(next) + "&err=" + encodeURIComponent("Enter a valid date of birth."));
    }

    const errRedirect = (msg: string) =>
      c.redirect(`/signup?next=${encodeURIComponent(next)}&err=${encodeURIComponent(msg)}`);

    if (birthDate > ageCutoff(now)) {
      return errRedirect("CombatForge accounts are currently for players age 13 and older.");
    }
    const v = validateChosenName(String(form["username"] ?? ""));
    if (!v.ok) return errRedirect(v.reason);
    const username = v.name;
    if (password.length < 8) {
      return errRedirect("Password must be at least 8 characters.");
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
      return errRedirect(msg);
    }

    const done = c.redirect(next);
    return passCookies(res, done);
  });

  app.get("/welcome-kid", (c) => c.redirect("/signup"));

  // ---- account home (the logged-in landing) ----
  // Every plain login/signup ends here so a signed-in player sees "you're all set", not the
  // device-code box (Tom 2026-07-17: clicking Log In looped back to the Link page).
  app.get("/account", async (c) => {
    const auth = buildAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.redirect("/login?next=" + encodeURIComponent("/account"));

    const uid = session.user.id;
    const [user, prof] = await Promise.all([
      c.env.DB.prepare(
        `SELECT username, displayUsername, isChild, turns13On, createdAt FROM user WHERE id = ?`).bind(uid).first(),
      c.env.DB.prepare(`SELECT * FROM app_profiles WHERE user_id = ?`).bind(uid).first(),
    ]);
    const displayName = (user?.displayUsername as string) ?? (user?.username as string) ?? "Player";
    const isChild = !!(user?.isChild);
    if (isChild) {
      return c.html(page("Account unavailable", `
        <h1>This account is unavailable</h1>
        <p class="err">CombatForge accounts are currently for players age 13 and older.</p>
        <form method="post" action="/logout"><button class="secondary">Log out</button></form>`), 403);
    }

    // Stats (all default to 0 for a brand-new player who hasn't finished a match yet).
    const xpTotal = (prof?.xp_total as number) ?? 0;
    const playSec = (prof?.playtime_sec as number) ?? 0;
    const matches = (prof?.matches_played as number) ?? 0;
    const wins = (prof?.wins as number) ?? 0;
    const elims = (prof?.eliminations as number) ?? 0;
    const deaths = (prof?.times_eliminated as number) ?? 0;
    const tags = (prof?.tags as number) ?? 0;
    const builder = (prof?.builder as number) ?? 0;
    const prog = levelProgress(xpTotal);

    const hours = (playSec / 3600);
    const playLabel = playSec < 60 ? "0h"
      : hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(playSec / 60)}m`;
    const winRate = matches > 0 ? `${Math.round((wins / matches) * 100)}%` : "—";
    const kd = deaths > 0 ? (elims / deaths).toFixed(2) : (elims > 0 ? elims.toFixed(2) : "—");
    const memberSince = user?.createdAt
      ? new Date(user.createdAt as string).toLocaleDateString("en-US",
          { year: "numeric", month: "short", day: "numeric" })
      : "—";
    const pct = prog.next > 0 ? Math.round((prog.into / prog.next) * 100) : 100;
    const okMsg = c.req.query("ok") ?? "";

    const stat = (label: string, value: string | number) =>
      `<div class="stat"><div class="stat-v">${escapeHtml(value)}</div><div class="stat-l">${escapeHtml(label)}</div></div>`;

    return c.html(page("Your account", `
      <h1>Hi, <span class="ok">${escapeHtml(displayName)}</span> 👋</h1>
      ${okMsg ? `<p class="ok">${escapeHtml(okMsg)}</p>` : ""}

      <div class="level-card">
        <div class="level-badge">${prog.level}</div>
        <div class="level-body">
          <div class="level-top"><b>Level ${prog.level}</b><span class="xp-num">${xpTotal.toLocaleString()} XP</span></div>
          <div class="xp-bar"><div class="xp-fill" style="width:${pct}%"></div></div>
          <div class="level-sub">${prog.next > 0 ? `${prog.into.toLocaleString()} / ${prog.next.toLocaleString()} XP to Level ${prog.level + 1}` : "Max level reached"}</div>
        </div>
      </div>

      <div class="stat-grid">
        ${stat("Play time", playLabel)}
        ${stat("Matches", matches.toLocaleString())}
        ${stat("Wins", wins.toLocaleString())}
        ${stat("Win rate", winRate)}
        ${stat("Eliminations", elims.toLocaleString())}
        ${stat("E / D", kd)}
        ${stat("Tags", tags.toLocaleString())}
        ${stat("Builder pieces", builder.toLocaleString())}
        ${stat("Member since", memberSince)}
      </div>

      ${matches === 0 ? `<p class="note">No matches yet — your stats fill in after your first online match.</p>` : ""}
      <div class="account-box">
        <p><b>To play:</b> open CombatForge and choose <b>ONLINE</b>. If it asks you to LOG IN, it
        shows a 6-character code — enter it below to connect that device.</p>
      </div>
      <a class="btn-link" href="/link">Link a game / enter a code</a>
      <p class="divider">·</p>
      <form method="post" action="/logout"><button class="secondary">Log out</button></form>`));
  });

  app.post("/logout", async (c) => {
    await authPost(c.env, "/sign-out", {}, c.req.header("Cookie") ?? null);
    // Clear the cookie regardless and send them back to the login screen.
    const res = c.redirect("/login");
    res.headers.set("set-cookie",
      "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    return res;
  });

  // ---- login ----
  // Most first-time visitors land here FROM the /link redirect (a brand-new player who just got
  // a code in-game and has no account yet) — the "create an account" path needs to read as the
  // obvious next step for them, not a footnote (Tom 2026-07-17: got a code, no clue how to sign up).
  app.get("/login", async (c) => {
    const err = c.req.query("err") ?? "";
    const next = safeNext(c.req.query("next"));
    // Already signed in? Don't show a login form — go straight to where they were headed
    // (their account by default). This is what stops "Log In" from looping back to the code box.
    const auth = buildAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) return c.redirect(next);
    return c.html(page("Log in", `
      <h1>Log in to CombatForge</h1>
      ${err ? `<p class="err">${escapeHtml(err)}</p>` : ""}
      <a class="btn-link" href="/signup?next=${encodeURIComponent(next)}">New here? Create a free account — takes 30 seconds</a>
      <p class="divider">— or, if you already have an account —</p>
      <form method="post" action="/login?next=${encodeURIComponent(next)}">
        <input name="username" placeholder="player name" required maxlength="16">
        <input name="password" type="password" placeholder="password" required>
        <button>Log in</button>
      </form>`));
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(c.req.query("next"));
    const submittedUsername = String(form["username"] ?? "").trim();
    const restricted = await c.env.DB.prepare(
      `SELECT isChild FROM user WHERE username = ? COLLATE NOCASE`).bind(submittedUsername).first();
    if (restricted?.isChild) {
      return c.redirect(`/login?next=${encodeURIComponent(next)}&err=` +
        encodeURIComponent("CombatForge accounts are currently for players age 13 and older."));
    }
    const res = await authPost(c.env, "/sign-in/username", {
      username: submittedUsername, password: String(form["password"] ?? ""),
    }, null);
    if (!res.ok) {
      return c.redirect(`/login?next=${encodeURIComponent(next)}&err=` + encodeURIComponent("Wrong name or password."));
    }
    return passCookies(res, c.redirect(next));
  });

  // ---- device link (the game shows a 6-char code; player approves it here) ----
  app.get("/link", async (c) => {
    // Must be logged in to approve — bounce to login (and, if brand new, on through signup) then
    // come straight back here so the code they're looking at in-game is still right there.
    const auth = buildAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.redirect("/login?next=" + encodeURIComponent("/link"));
    const restricted = await c.env.DB.prepare(
      `SELECT isChild FROM user WHERE id = ?`).bind(session.user.id).first();
    if (restricted?.isChild) return c.redirect("/account");
    const err = c.req.query("err") ?? "";
    const okMsg = c.req.query("ok") ?? "";
    return c.html(page("Link your game", `
      <h1>Link your game</h1>
      <p class="note">Start CombatForge, choose <b>LOG IN</b>, and type the 6-character code it
      shows you here.</p>
      ${err ? `<p class="err">${escapeHtml(err)}</p>` : ""}
      ${okMsg ? `<p class="ok">${escapeHtml(okMsg)}</p>` : ""}
      <form method="post" action="/link">
        <input class="code" name="userCode" placeholder="ABC123" maxlength="6" required
               autocomplete="off" autocapitalize="characters">
        <button>Approve this game</button>
      </form>
      <p class="divider">·</p>
      <p><a href="/account">← Back to your account</a></p>`));
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
    // Land on the account home with a success note — not back on the code box.
    return passCookies(res, c.redirect("/account?ok=" +
      encodeURIComponent("Game linked! Jump back into CombatForge and play.")));
  });

  // Bare API root → account (which bounces to login if signed out).
  app.get("/", (c) => c.redirect("/account"));

  return app;
}
