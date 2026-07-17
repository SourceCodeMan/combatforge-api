/**
 * XP rules v1 (docs/progression-plan.md §2). Servers report RAW STATS; XP amounts are computed
 * HERE under a versioned rule set so tuning never needs a fleet redeploy and history is replayable.
 * Kids-casual economy: completion is the biggest chunk, objective/builder play out-earns slaying,
 * modest win bonus, first MATCH of day (participation, not win), NO streaks/FOMO.
 */

export const RULE_VERSION = 1;

export interface PlayerStats {
  elims: number;
  tags: number;
  objective: number; // rolled-up objective points reported by the server
  builder: number;   // pieces surviving to round end
  completed: boolean;
  won: boolean;
}

export interface XpEvent {
  source: string;
  amount: number;
}

const CLAMP_MAX_PER_MATCH = 1500; // plausibility ceiling (defense-in-depth even with valid server keys)

export function computeXpEvents(s: PlayerStats, isFirstMatchOfDay: boolean): XpEvent[] {
  const events: XpEvent[] = [];
  if (s.completed) events.push({ source: "completion", amount: 250 });
  const elimXp = Math.min(s.elims + s.tags, 40) * 10; // 40 elims/tags cap ≈ plausibility
  if (elimXp > 0) events.push({ source: "elims", amount: elimXp });
  const objXp = Math.min(s.objective, 30) * 10;
  if (objXp > 0) events.push({ source: "objective", amount: objXp });
  const builderXp = Math.min(s.builder, 50) * 2;
  if (builderXp > 0) events.push({ source: "builder", amount: builderXp });
  if (s.won) events.push({ source: "win", amount: 100 });
  if (isFirstMatchOfDay && s.completed) events.push({ source: "daily", amount: 250 });

  // Global clamp: scale down proportionally if a match somehow exceeds the ceiling.
  const total = events.reduce((a, e) => a + e.amount, 0);
  if (total > CLAMP_MAX_PER_MATCH) {
    const k = CLAMP_MAX_PER_MATCH / total;
    for (const e of events) e.amount = Math.floor(e.amount * k);
  }
  return events;
}

/** Soft-exponential curve, cap 50: cost(L→L+1) = 600 × 1.06^L rounded to 50s. */
export const LEVEL_CAP = 50;

export function costForLevel(level: number): number {
  return Math.round((600 * Math.pow(1.06, level)) / 50) * 50;
}

export function levelForXp(xpTotal: number): number {
  let level = 1;
  let spent = 0;
  while (level < LEVEL_CAP) {
    const cost = costForLevel(level);
    if (spent + cost > xpTotal) break;
    spent += cost;
    level++;
  }
  return level;
}

/** XP into the current level + cost of the next (for the client's progress bar). */
export function levelProgress(xpTotal: number): { level: number; into: number; next: number } {
  let level = 1;
  let spent = 0;
  while (level < LEVEL_CAP) {
    const cost = costForLevel(level);
    if (spent + cost > xpTotal) return { level, into: xpTotal - spent, next: cost };
    spent += cost;
    level++;
  }
  return { level: LEVEL_CAP, into: 0, next: 0 };
}
