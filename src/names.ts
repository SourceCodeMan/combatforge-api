import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

/**
 * Display-name policy (docs/multiplayer-plan.md §4, kid-safe):
 *  - 3..16 chars, [A-Za-z0-9_] only (engine truncates connect names at 20 — stay under).
 *  - Obscenity-filtered (leetspeak/homoglyph aware) + reserved words.
 *  - Must never function as ONLINE CONTACT INFO (COPPA): reject email shapes + long digit runs.
 *  - Under-13 accounts NEVER type a name: they get a generated adjective+animal name and the
 *    rename option auto-unlocks the day they turn 13 (Tom 2026-07-17).
 */

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const RESERVED = [
  "admin", "moderator", "mod_", "combatforge", "playcombat", "server", "system",
  "official", "staff", "owner", "tom_chapman", "console",
];

export function validateChosenName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    return { ok: false, reason: "Names are 3-16 characters: letters, numbers, underscore." };
  }
  if (/\d{5,}/.test(name)) {
    return { ok: false, reason: "Names can't contain long number runs." }; // phone-number shapes
  }
  const lower = name.toLowerCase();
  if (RESERVED.some((r) => lower.includes(r))) {
    return { ok: false, reason: "That name is reserved." };
  }
  if (matcher.hasMatch(name) || matcher.hasMatch(lower.replace(/_/g, " "))) {
    return { ok: false, reason: "That name isn't allowed." };
  }
  return { ok: true, name };
}

// Kid-safe generator: adjective + animal + 2 digits (e.g. "SwiftFalcon42").
const ADJECTIVES = [
  "Swift", "Brave", "Mighty", "Sneaky", "Turbo", "Cosmic", "Shadow", "Blazing",
  "Frosty", "Thunder", "Silent", "Golden", "Iron", "Neon", "Rapid", "Stealthy",
  "Crimson", "Electric", "Rocket", "Storm", "Lucky", "Wild", "Nova", "Hyper",
];
const ANIMALS = [
  "Falcon", "Wolf", "Tiger", "Panther", "Hawk", "Fox", "Bear", "Viper",
  "Raptor", "Lynx", "Cobra", "Eagle", "Otter", "Moose", "Badger", "Puma",
  "Gecko", "Raven", "Shark", "Bison", "Coyote", "Heron", "Mantis", "Osprey",
];

export function generateKidName(): string {
  const r = crypto.getRandomValues(new Uint32Array(3));
  const adj = ADJECTIVES[r[0] % ADJECTIVES.length];
  const animal = ANIMALS[r[1] % ANIMALS.length];
  const num = 10 + (r[2] % 90);
  return `${adj}${animal}${num}`; // max len 24? no: longest adj 8 + animal 7 + 2 = 17 — see clamp below
}

/** Generate until it fits the 16-char cap (a couple of tries at most). */
export function generateKidNameClamped(): string {
  for (let i = 0; i < 10; i++) {
    const n = generateKidName();
    if (n.length <= 16) return n;
  }
  return `Player${10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90)}`;
}
