// Generation-only Better Auth config for `npx @better-auth/cli generate`.
// Mirrors src/auth.ts exactly (same plugins + additionalFields) so the emitted SQL matches
// what the runtime expects. The D1 binding is stubbed — schema generation never connects.
import { betterAuth } from "better-auth";
import { username, bearer, deviceAuthorization } from "better-auth/plugins";
import Database from "better-sqlite3";

export const auth = betterAuth({
  baseURL: "https://api.playcombatforge.com",
  secret: "generation-only-not-a-real-secret",
  basePath: "/api/auth",
  // In-memory sqlite ONLY for CLI introspection — runtime uses D1 (src/auth.ts).
  database: new Database(":memory:"),
  emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 8 },
  user: {
    additionalFields: {
      isChild: { type: "boolean", defaultValue: false, input: false },
      turns13On: { type: "string", required: false, input: false },
    },
  },
  plugins: [
    username({ minUsernameLength: 3, maxUsernameLength: 16 }),
    bearer(),
    deviceAuthorization({ verificationUri: "/link", expiresIn: "15m", interval: "5s" }),
  ],
});
