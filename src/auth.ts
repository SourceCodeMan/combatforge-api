import { betterAuth } from "better-auth";
import { username, bearer, deviceAuthorization } from "better-auth/plugins";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./env";

/**
 * Better Auth instance, built per-request (Workers only expose env per-request).
 * Pinned better-auth >= 1.6.11 (device-flow hijack GHSA-cq3f-vc6p-68fh fixed in 1.6.11).
 *
 * Identity model (release posture):
 *  - Accounts are 13+ only. /signup performs the age check before invoking Better Auth and never
 *    stores the submitted birth date.
 *  - Username + password; a non-routable placeholder email satisfies the core schema without
 *    collecting contact information.
 *  - The GAME never sees a password: it logs in via the RFC 8628 device flow
 *    (shows a 6-char code -> player approves at /link in a browser) and stores the
 *    resulting session token, sent as Authorization: Bearer (bearer plugin).
 */
export function buildAuth(env: Env) {
  return betterAuth({
    baseURL: env.PUBLIC_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    basePath: "/api/auth",
    // NOTE: wrangler local dev rewrites the request host/origin to the configured custom-domain
    // route (api.playcombatforge.com, http scheme) — trust it in BOTH schemes plus localhost,
    // or every cookie-authenticated POST fails CSRF with INVALID_ORIGIN in dev.
    trustedOrigins: [
      env.PUBLIC_BASE_URL,
      "https://api.playcombatforge.com",
      "http://api.playcombatforge.com",
      "https://playcombatforge.com",
      "http://127.0.0.1:8787",
      "http://localhost:8787",
    ],
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: "sqlite",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // kids accounts have no real email; 13+ verification later
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        isChild: { type: "boolean", defaultValue: false, input: false },
        turns13On: { type: "string", required: false, input: false }, // "YYYY-MM-DD" rename unlock date
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
    },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 16, // engine truncates ?Name= at 20 — stay comfortably under
      }),
      bearer(),
      deviceAuthorization({
        verificationUri: "/link",
        expiresIn: "15m",
        interval: "5s",
        userCodeLength: 6,
        // Unambiguous alphabet: no 0/O/1/I/L — kids read these codes off a TV to a parent.
        generateUserCode: () => {
          const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
          const bytes = crypto.getRandomValues(new Uint8Array(6));
          let code = "";
          for (const b of bytes) code += alphabet[b % alphabet.length];
          return code;
        },
        validateClient: (clientId: string) => clientId === env.GAME_CLIENT_ID,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;
