/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  GAME_CLIENT_ID: string;
  PUBLIC_BASE_URL: string;
  BETTER_AUTH_SECRET: string;
  ADMIN_KEY: string;
  // Kill switch for /v1/casual-report (honor-system XP). Declared here so the check is typed:
  // it used to be read through `(c.env as any)`, which is how the value silently went unset.
  CASUAL_XP_ENABLED?: string;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
