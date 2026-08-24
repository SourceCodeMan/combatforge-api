import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const columns = (db, table) => new Set(
  db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
);
const tableExists = (db, table) => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
).get(table);


{
  const db = new Database(":memory:");
  try {
    for (const file of ["sql/schema.sql", "sql/auth-schema.sql", "sql/seed.sql"]) db.exec(read(file));

    assert(columns(db, "app_profiles").has("builder"), "fresh schema lacks app_profiles.builder");
    for (const name of ["daily_bonus_claims", "promo_redemptions", "casual_daily_xp"]) {
      assert(tableExists(db, name), `fresh schema lacks ${name}`);
    }
    for (const name of ["processing_token", "processed_at"]) {
      assert(columns(db, "matches").has(name), `fresh matches table lacks ${name}`);
      assert(columns(db, "casual_reports").has(name), `fresh casual_reports table lacks ${name}`);
    }
    assert(columns(db, "casual_reports").has("granted"), "fresh casual_reports table lacks granted");

    const criterion = JSON.parse(db.prepare(
      "SELECT criteria FROM unlock_definitions WHERE unlock_id = 'badge_builder_500'",
    ).pluck().get());
    assert(criterion.stat === "builder" && criterion.gte === 500, "builder badge seed is incorrect");
    assert(db.pragma("quick_check", { simple: true }) === "ok", "fresh schema failed SQLite quick_check");
  } finally {
    db.close();
  }
}

const baseRef = (process.env.CI_BASE_REF ?? "").trim();
if (baseRef) {
  const fromBase = (relative) => execFileSync("git", ["show", `${baseRef}:${relative}`], {
    cwd: root,
    encoding: "utf8",
  });
  const oldSchema = fromBase("sql/schema.sql");

  if (/\bbuilder\s+INTEGER\b/.test(oldSchema) && /CREATE TABLE (?:IF NOT EXISTS )?promo_redemptions\b/.test(oldSchema)) {
    console.log(`SKIP migration fixture: ${baseRef} already contains the Epic hardening schema`);
  } else {
    const db = new Database(":memory:");
    try {
      db.exec(oldSchema);
      db.exec(fromBase("sql/auth-schema.sql"));
      db.exec(fromBase("sql/seed.sql"));

      db.prepare("INSERT INTO app_profiles (user_id, xp_total) VALUES ('legacy-user', 321)").run();
      db.prepare(`INSERT INTO matches
        (match_id, server_id, mode, map, ended_at, duration_sec, winner_team, net_protocol, raw)
        VALUES ('legacy-match', 'server-1', 'Skirmish', 'WAREHOUSE', 172801, 600, 0, 19, '{}')`).run();
      db.prepare(
        "INSERT INTO casual_reports (user_id, match_id, created_at) VALUES ('legacy-user', 'casual-1', 172802)",
      ).run();
      db.prepare(`INSERT INTO xp_events
        (user_id, match_id, source, amount, rule_version, created_at)
        VALUES ('legacy-user', 'legacy-match', 'daily', 250, 1, 172803)`).run();

      db.exec(read("sql/migrations/0001_epic_hardening.sql"));

      const profile = db.prepare(
        "SELECT xp_total, builder FROM app_profiles WHERE user_id = 'legacy-user'",
      ).get();
      assert(profile?.xp_total === 321 && profile?.builder === 0, "profile migration lost legacy data");
      const match = db.prepare(
        "SELECT processed_at, processing_token FROM matches WHERE match_id = 'legacy-match'",
      ).get();
      assert(match?.processed_at === 172801 && match.processing_token === null,
        "match migration did not finalize legacy rows");
      const casual = db.prepare(
        "SELECT processed_at, processing_token, granted FROM casual_reports WHERE match_id = 'casual-1'",
      ).get();
      assert(casual?.processed_at === 172802 && casual.processing_token === null && casual.granted === 0,
        "casual migration did not preserve legacy rows");
      assert(db.prepare(
        "SELECT match_id FROM daily_bonus_claims WHERE user_id = 'legacy-user' AND day_start = 172800",
      ).pluck().get() === "legacy-match", "daily bonus migration did not preserve the historical claim");
      assert(tableExists(db, "promo_redemptions"), "migration did not create promo_redemptions");

      const criterion = JSON.parse(db.prepare(
        "SELECT criteria FROM unlock_definitions WHERE unlock_id = 'badge_builder_500'",
      ).pluck().get());
      assert(criterion.stat === "builder", "migration did not repair the builder badge criterion");
      assert(db.pragma("quick_check", { simple: true }) === "ok", "migrated schema failed SQLite quick_check");
    } finally {
      db.close();
    }
    console.log(`PASS production migration fixture from ${baseRef}`);
  }
}

console.log("PASS fresh API schema, seed, and release invariants");
