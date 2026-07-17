/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  GAME_CLIENT_ID: string;
  PUBLIC_BASE_URL: string;
  BETTER_AUTH_SECRET: string;
  ADMIN_KEY: string;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
