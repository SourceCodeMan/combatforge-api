import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { Hono } from "hono";

import { casualRoutes } from "../src/casual.ts";
import { reportRoutes } from "../src/reports.ts";
import { profileRoutes, storeRoutes } from "../src/store.ts";


const root = process.cwd();
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

class MockStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new MockStatement(this.db, this.sql, args);
  }

  run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return Promise.resolve({
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
    });
  }

  all() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return Promise.resolve({ success: true, results: rows, meta: { changes: 0 } });
  }

  first() {
    return Promise.resolve(this.db.prepare(this.sql).get(...this.args) ?? null);
  }
}

class MockD1 {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new MockStatement(this.db, sql);
  }

  batch(statements) {
    return Promise.resolve(this.db.transaction(() => statements.map((statement) => {
      const info = this.db.prepare(statement.sql).run(...statement.args);
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      };
    }))());
  }
}

const db = new Database(":memory:");
try {
  for (const file of ["sql/schema.sql", "sql/auth-schema.sql", "sql/seed.sql"]) {
    db.exec(fs.readFileSync(path.join(root, file), "utf8"));
  }
  const insertUser = db.prepare(`INSERT INTO user
    (id,name,email,emailVerified,createdAt,updatedAt,username,displayUsername,isChild)
    VALUES (?,?,?,?,?,?,?,?,0)`);
  insertUser.run("u1", "PlayerOne", "one@test.invalid", 0,
    new Date().toISOString(), new Date().toISOString(), "playerone", "PlayerOne");
  insertUser.run("u2", "PlayerTwo", "two@test.invalid", 0,
    new Date().toISOString(), new Date().toISOString(), "playertwo", "PlayerTwo");

  const serverKey = "test-server-key-which-is-long-and-random-enough";
  const keyHash = createHash("sha256").update(serverKey).digest("hex");
  db.prepare(`INSERT INTO game_servers (server_id,name,key_hash,region,active,created_at)
    VALUES ('s1','Test',?,'us-east',1,?)`).run(keyHash, Math.floor(Date.now() / 1000));
  db.prepare(`INSERT INTO identities (guid_hash,user_id,linked_at,last_seen_at)
    VALUES (?,?,?,?)`).run("a".repeat(40), "u1", 1, 1);

  const env = {
    DB: new MockD1(db),
    CASUAL_XP_ENABLED: "1",
    ADMIN_KEY: "test-admin-key-which-is-at-least-32-characters",
    GAME_CLIENT_ID: "combatforge-game",
    PUBLIC_BASE_URL: "https://api.test.invalid",
    BETTER_AUTH_SECRET: "test-auth-secret-which-is-at-least-32-characters",
  };
  const app = new Hono();
  app.route("/v1", reportRoutes);
  const userRoutes = new Hono();
  userRoutes.use("*", async (c, next) => {
    c.set("userId", c.req.header("X-Test-User") || "u1");
    await next();
  });
  userRoutes.route("/", casualRoutes);
  userRoutes.route("/", profileRoutes);
  userRoutes.route("/", storeRoutes);
  app.route("/u", userRoutes);

  const json = async (response) => ({ status: response.status, body: await response.json() });
  const sendMatch = async (matchId, overrides = {}) => {
    const report = {
      matchId,
      mode: "Skirmish",
      map: "WAREHOUSE",
      endedAt: Math.floor(Date.now() / 1000),
      durationSec: 700,
      winnerTeam: 0,
      netProtocol: 20,
      players: [{
        guidHash: "a".repeat(40), team: 0, elims: 7, timesElim: 3, score: 9,
        tags: 7, objective: 2, builder: 12, completed: true,
      }],
      ...overrides,
    };
    const body = JSON.stringify(report);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", serverKey).update(`${timestamp}.${body}`).digest("hex");
    return json(await app.request("/v1/match-report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverKey}`,
        "X-Timestamp": String(timestamp),
        "X-Signature": signature,
        "Content-Type": "application/json",
      },
      body,
    }, env));
  };

  const first = await sendMatch("match-1");
  assert(first.status === 200 && first.body.granted === 1, `first match failed: ${JSON.stringify(first)}`);
  assert(db.prepare("SELECT xp_total FROM app_profiles WHERE user_id='u1'").pluck().get() === 784,
    "first XP projection mismatch");
  assert(db.prepare("SELECT processed_at FROM matches WHERE match_id='match-1'").pluck().get() > 0,
    "match was not finalized");

  const duplicate = await sendMatch("match-1");
  assert(duplicate.body.duplicate === true, "duplicate match was not acknowledged idempotently");
  assert(db.prepare("SELECT xp_total FROM app_profiles WHERE user_id='u1'").pluck().get() === 784,
    "duplicate match changed XP");

  const second = await sendMatch("match-2");
  assert(second.status === 200 && second.body.granted === 1, "second match failed");
  assert(db.prepare("SELECT xp_total FROM app_profiles WHERE user_id='u1'").pluck().get() === 1318,
    "daily bonus was granted twice");

  const casualBody = JSON.stringify({
    matchId: "casual-1",
    durationSec: 700,
    stats: { elims: 7, tags: 7, objective: 2, builder: 12, completed: true, won: true },
  });
  const casual = await json(await app.request("/u/casual-report", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: casualBody,
  }, env));
  assert(casual.status === 200 && casual.body.granted === 267,
    `casual grant mismatch: ${JSON.stringify(casual)}`);
  const casualDuplicate = await json(await app.request("/u/casual-report", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: casualBody,
  }, env));
  assert(casualDuplicate.body.duplicate === true, "casual duplicate was not idempotent");

  const malformedCasual = await json(await app.request("/u/casual-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId: "casual-bad", durationSec: 700.5, stats: { elims: "99" } }),
  }, env));
  assert(malformedCasual.status === 400, "malformed casual stats were accepted");

  const linked = await json(await app.request("/u/identities/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guidHash: "c".repeat(40) }),
  }, env));
  assert(linked.status === 200, "identity claim failed");
  const stolen = await json(await app.request("/u/identities/link", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
    body: JSON.stringify({ guidHash: "c".repeat(40) }),
  }, env));
  assert(stolen.status === 409, "identity takeover was accepted");

  db.prepare(`INSERT INTO promo_codes (code,entitlement_id,max_uses,uses,created_at)
    VALUES ('ONESHOT','all_access',1,0,?)`).run(Math.floor(Date.now() / 1000));
  const redeem = await json(await app.request("/u/promo/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ONESHOT" }),
  }, env));
  assert(redeem.status === 200 && redeem.body.entitlement === "all_access", "promo redemption failed");
  const retry = await json(await app.request("/u/promo/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ONESHOT" }),
  }, env));
  assert(retry.status === 200 && retry.body.alreadyRedeemed === true,
    "same-user promo retry was not idempotent");
  const exhausted = await json(await app.request("/u/promo/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
    body: JSON.stringify({ code: "ONESHOT" }),
  }, env));
  assert(exhausted.status === 410, "fully used promo was granted twice");
  assert(db.prepare("SELECT uses FROM promo_codes WHERE code='ONESHOT'").pluck().get() === 1,
    "promo use counter mismatch");

  console.log("PASS API route integration: match/daily/casual/identity/promo invariants");
} finally {
  db.close();
}
