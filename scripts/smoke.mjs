// End-to-end smoke test against a local `wrangler dev` (http://127.0.0.1:8787).
// Exercises the EXACT flows the game + fleet will use:
//   admin provision -> server register/heartbeat -> 13+ signup -> under-13 rejection ->
//   device-link (code -> approve -> token) -> Bearer profile/servers/quickplay ->
//   HMAC match-report (XP grant) -> duplicate report (idempotent) -> promo redeem -> store.
// Usage:  node scripts/smoke.mjs   (requires: npm run schema:local, then npm run dev with
//         ADMIN_KEY + BETTER_AUTH_SECRET in .dev.vars)
import { createHmac } from "node:crypto";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const ADMIN_KEY = process.env.SMOKE_ADMIN_KEY ?? "dev-admin-key";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <-- " + detail}`);
  if (!cond) failures++;
};

const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})), headers: res.headers });

async function main() {
  // 0. health
  {
    const r = await j(await fetch(`${BASE}/healthz`));
    check("healthz", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    check("security headers", (r.headers.get("content-security-policy") ?? "").includes("default-src 'self'"),
      `csp=${r.headers.get("content-security-policy")}`);
  }

  // 1. admin: provision a fleet server key
  let serverKey = "", serverId = "";
  {
    const r = await j(await fetch(`${BASE}/v1/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ name: "smoke-vps-1", region: "us-east" }),
    }));
    check("admin provision server", r.status === 200 && r.body.key, JSON.stringify(r.body));
    serverKey = r.body.key; serverId = r.body.serverId;
  }

  // 1b. admin auth actually enforced
  {
    const r = await j(await fetch(`${BASE}/v1/admin/servers`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ name: "nope" }),
    }));
    check("admin rejects bad key", r.status === 403, `status=${r.status}`);
  }

  // 2. fleet: register + heartbeat
  {
    const r = await j(await fetch(`${BASE}/v1/servers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serverKey}` },
      body: JSON.stringify({ port: 7777, netProtocol: 4, map: "WAREHOUSE", mode: "Skirmish", maxPlayers: 12 }),
    }));
    check("server register", r.status === 200 && r.body.ok, JSON.stringify(r.body));
    const hb = await j(await fetch(`${BASE}/v1/servers/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serverKey}` },
      body: JSON.stringify({ players: 3, phase: "Combat" }),
    }));
    check("server heartbeat", hb.status === 200 && hb.body.ok, JSON.stringify(hb.body));
  }

  // 3. signup: adult (chosen name) — grab the session cookie from the redirect chain
  const adultName = "SmokeAdult" + Math.floor(Math.random() * 900 + 100);
  let adultCookie = "";
  {
    const form = new URLSearchParams({ birthDate: "1990-06-15", username: adultName, password: "hunter2hunter2" });
    const r = await fetch(`${BASE}/signup`, { method: "POST", body: form, redirect: "manual" });
    adultCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    check("adult signup sets session", r.status === 302 && adultCookie.length > 5,
      `status=${r.status} cookie=${adultCookie}`);
  }

  // 3b. filtered name rejected
  {
    const form = new URLSearchParams({ birthDate: "1990-06-15", username: "admin_fuck", password: "hunter2hunter2" });
    const r = await fetch(`${BASE}/signup`, { method: "POST", body: form, redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    check("bad name rejected", loc.includes("err="), `location=${loc}`);
  }

  // 3c. under-13 signup is rejected before an account/session is created
  {
    const year = new Date().getUTCFullYear() - 9;
    const form = new URLSearchParams({ birthDate: `${year}-06-15`, username: "TooYoungPlayer", password: "kidpassword1" });
    const r = await fetch(`${BASE}/signup`, { method: "POST", body: form, redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    check("under-13 signup rejected", r.status === 302 && loc.includes("err=") && !(r.headers.get("set-cookie") ?? ""),
      `status=${r.status} loc=${loc}`);
  }

  // 3d. reflected query strings are escaped, not interpreted as HTML.
  {
    const r = await fetch(`${BASE}/login?err=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
    const html = await r.text();
    check("login error HTML escaped", !html.includes("<img src=x") && html.includes("&lt;img"), html.slice(0, 200));
  }

  // A second account is used to prove install identities cannot be stolen and promo limits are per claim.
  const secondName = "SmokeSecond" + Math.floor(Math.random() * 900 + 100);
  let secondCookie = "";
  {
    const form = new URLSearchParams({ birthDate: "1991-03-20", username: secondName, password: "hunter2hunter2" });
    const r = await fetch(`${BASE}/signup`, { method: "POST", body: form, redirect: "manual" });
    secondCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    check("second account signup", r.status === 302 && secondCookie.length > 5, `status=${r.status}`);
  }

  // 4. device-link flow (the game's login): code -> approve (web session) -> token poll
  let gameBearer = "";
  {
    const code = await j(await fetch(`${BASE}/api/auth/device/code`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "combatforge-game" }),
    }));
    check("device code issued", code.status === 200 && code.body.user_code && code.body.device_code,
      JSON.stringify(code.body));

    const approve = await fetch(`${BASE}/link`, {
      method: "POST",
      headers: { Cookie: adultCookie },
      body: new URLSearchParams({ userCode: code.body.user_code ?? "" }),
      redirect: "manual",
    });
    const loc = approve.headers.get("location") ?? "";
    check("device approved via /link", loc.includes("ok="), `loc=${loc}`);

    const token = await j(await fetch(`${BASE}/api/auth/device/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.body.device_code, client_id: "combatforge-game",
      }),
    }));
    gameBearer = token.body.access_token ?? token.body.token ?? "";
    check("device token grants access", token.status === 200 && gameBearer.length > 5,
      JSON.stringify(token.body));
  }

  // 5. Bearer-authenticated client endpoints (what the GAME calls)
  const gameHeaders = { Authorization: `Bearer ${gameBearer}` };
  let userId = "";
  {
    const prof = await j(await fetch(`${BASE}/v1/profile/me`, { headers: gameHeaders }));
    userId = prof.body.userId ?? "";
    check("profile/me via Bearer", prof.status === 200 && prof.body.displayName === adultName,
      JSON.stringify(prof.body));
    const unauth = await j(await fetch(`${BASE}/v1/profile/me`));
    check("profile requires auth", unauth.status === 401, `status=${unauth.status}`);
    const servers = await j(await fetch(`${BASE}/v1/servers`, { headers: gameHeaders }));
    check("server browser list", servers.status === 200 && servers.body.servers?.length >= 1,
      JSON.stringify(servers.body));
    const qp = await j(await fetch(`${BASE}/v1/quickplay?netProtocol=4`, { headers: gameHeaders }));
    check("quickplay finds the server", qp.status === 200 && qp.body.server?.port === 7777,
      JSON.stringify(qp.body));
    const guid = "a".repeat(40);
    const link = await j(await fetch(`${BASE}/v1/identities/link`, {
      method: "POST", headers: { ...gameHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ guidHash: guid }),
    }));
    check("identity link", link.status === 200 && link.body.ok, JSON.stringify(link.body));
    const steal = await j(await fetch(`${BASE}/v1/identities/link`, {
      method: "POST", headers: { Cookie: secondCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ guidHash: guid }),
    }));
    check("identity takeover rejected", steal.status === 409, JSON.stringify(steal.body));
  }

  // 6. match report (fleet, HMAC) -> XP grant; then duplicate -> idempotent
  {
    const report = {
      matchId: "smoke-" + Date.now(), mode: "Skirmish", map: "WAREHOUSE",
      endedAt: Math.floor(Date.now() / 1000), durationSec: 700, winnerTeam: 0, netProtocol: 4,
      players: [
        { guidHash: "a".repeat(40), team: 0, elims: 7, timesElim: 3, score: 9, tags: 7,
          objective: 2, builder: 12, completed: true },
        { guidHash: "b".repeat(40), team: 1, elims: 3, timesElim: 7, score: 3, tags: 3,
          objective: 0, builder: 4, completed: true, isBot: true },
      ],
    };
    const body = JSON.stringify(report);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", serverKey).update(`${ts}.${body}`).digest("hex");
    const headers = {
      "Content-Type": "application/json", Authorization: `Bearer ${serverKey}`,
      "X-Timestamp": String(ts), "X-Signature": sig,
    };
    const r1 = await j(await fetch(`${BASE}/v1/match-report`, { method: "POST", headers, body }));
    check("match report accepted + grants", r1.status === 200 && r1.body.ok && r1.body.granted === 1,
      JSON.stringify(r1.body));
    const r2 = await j(await fetch(`${BASE}/v1/match-report`, { method: "POST", headers, body }));
    check("duplicate report idempotent", r2.status === 200 && r2.body.duplicate === true,
      JSON.stringify(r2.body));
    const badSig = await j(await fetch(`${BASE}/v1/match-report`, {
      method: "POST", headers: { ...headers, "X-Signature": "0".repeat(64) }, body,
    }));
    check("bad signature rejected", badSig.status === 401, `status=${badSig.status}`);

    const prof = await j(await fetch(`${BASE}/v1/profile/me`, { headers: gameHeaders }));
    // completion 250 + elims (7+7=14)*10=140 + objective 2*10=20 + builder 12*2=24 + win 100 + daily 250 = 784
    check("XP landed on profile", prof.status === 200 && prof.body.xpTotal === 784,
      `xpTotal=${prof.body.xpTotal} (expected 784)`);
  }

  // 7. store + promo (comp flow): mint code -> redeem -> entitlement + unlock granted
  {
    const mint = await j(await fetch(`${BASE}/v1/admin/promo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ entitlementId: "all_access", maxUses: 1, note: "smoke comp" }),
    }));
    check("admin mints promo", mint.status === 200 && mint.body.code, JSON.stringify(mint.body));
    const redeem = await j(await fetch(`${BASE}/v1/promo/redeem`, {
      method: "POST", headers: { ...gameHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ code: mint.body.code }),
    }));
    check("promo redeems -> all_access + unlocks", redeem.status === 200 && redeem.body.entitlement === "all_access",
      JSON.stringify(redeem.body));
    const again = await j(await fetch(`${BASE}/v1/promo/redeem`, {
      method: "POST", headers: { ...gameHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ code: mint.body.code }),
    }));
    check("same-user promo retry idempotent", again.status === 200 && again.body.alreadyRedeemed === true,
      JSON.stringify(again.body));
    const other = await j(await fetch(`${BASE}/v1/promo/redeem`, {
      method: "POST", headers: { Cookie: secondCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: mint.body.code }),
    }));
    check("promo max-use enforced for another user", other.status === 410, JSON.stringify(other.body));
    const store = await j(await fetch(`${BASE}/v1/store`, { headers: gameHeaders }));
    const pack = store.body.packs?.find((p) => p.sku === "all_access");
    check("store shows owned pack", store.status === 200 && pack?.owned === true,
      JSON.stringify(store.body.packs));
    check("store lists unlocks", (store.body.unlocks?.length ?? 0) >= 5,
      `unlocks=${store.body.unlocks?.length}`);
  }

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE CRASH:", e); process.exit(1); });
