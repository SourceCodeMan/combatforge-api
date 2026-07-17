import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

/**
 * Display-name policy (docs/multiplayer-plan.md §4, kid-safe — Tom 2026-07-17: NO curse words,
 * NO sexually explicit words):
 *  - 3..16 chars, [A-Za-z0-9_] only (engine truncates connect names at 20 — stay under).
 *  - Two-layer profanity defense (see below) + reserved words.
 *  - Must never function as ONLINE CONTACT INFO (COPPA): reject email shapes + long digit runs.
 *  - Under-13 accounts NEVER type a name: they get a generated adjective+animal name and the
 *    rename option auto-unlocks the day they turn 13.
 *
 * Layer 1 — `obscenity`: strong leetspeak/homoglyph matcher with its own Scunthorpe allowlist
 *   (correctly permits Cockburn / Assassin / Bassmaster). Catches most standalone slurs.
 * Layer 2 — normalized root blocklist: obscenity MISSES a batch that matters for kids (dumbass,
 *   nude, jizz, sexyboy, coolshit99, phuck, azzhole…). We normalize away every common evasion
 *   (leet digits, ph→f, doubled letters, separators) then substring-match a curated root list.
 *   A SAFE_WORDS allowlist is subtracted first so real names that merely CONTAIN a root
 *   (Dickinson, Cumberland, Scunthorpe) survive. A rejected name only costs "pick another," so we
 *   lean strict: a slur slipping past for a kid to read is the failure that actually matters.
 */

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const RESERVED = [
  "admin", "moderator", "mod_", "combatforge", "playcombat", "server", "system",
  "official", "staff", "owner", "tom_chapman", "console",
];

/** Bad roots matched as substrings AFTER normalization. Scunthorpe-prone roots (ass/dick/cock/
 *  sex/cum/rape/tit/porn/anus) are rescued by SAFE_WORDS below, so they're safe to include. */
const BLOCK_ROOTS = [
  // profanity
  "fuck", "shit", "cunt", "bitch", "biatch", "beatch", "bastard", "asshole", "asshat",
  "dumbass", "jackass", "dickhead", "dikhead", "dick", "cock", "pussy", "wank", "twat", "prick",
  "bollock", "damn", "piss", "douche", "fuk", "fux", "shithead", "motherfuck",
  // sexual / explicit
  "sex", "seggs", "porn", "pron", "penis", "vagina", "anus", "cum", "jizz", "semen", "ejacul",
  "masturbat", "orgasm", "boner", "horny", "slut", "sloot", "whore", "hooker", "nude", "naked",
  "milf", "dildo", "boob", "tits", "titties", "clit", "scrotum", "ballsack", "nutsack",
  "cameltoe", "blowjob", "handjob", "rimjob", "jerkoff", "jackoff", "deepthroat", "gangbang",
  "cumshot", "hentai", "incest", "molest", "pedo", "rape", "bestial", "erotic", "fondle",
  "fetish", "xrated", "suckmy", "suckmi", "blowme", "eatmy", "smd",
  // slurs / hate
  "nigger", "nigga", "faggot", "fag", "retard", "spic", "chink", "kike", "wetback", "tranny",
  "nazi", "hitler", "kkk",
  // NOTE: self-harm/harassment abbreviations (kys, etc.) are deliberately NOT here — as bare
  // substrings they wreck innocent names ("LuckyShark" -> "luc-KYS-hark"). They're a separate
  // category from curse/sexual words and would need word-boundary logic to block safely.
];

/** Legit words that CONTAIN a blocked root — subtracted before the substring scan so real names
 *  survive (Scunthorpe mitigation). Only roots we actually block need entries here; bare "ass"
 *  isn't a root (obscenity handles Bass/Class/Assassin), so no ass-family words belong here —
 *  one ("bass") was wrongly rescuing "dumbass". */
const SAFE_WORDS = [
  "scunthorpe", "sussex", "essex", "unisex", "sexton",                                    // sex
  "cockburn", "hancock", "hitchcock", "peacock", "shuttlecock", "cockpit", "cocktail", "cockney", // cock
  "dickinson", "dickens", "dickerson",                                                    // dick
  "grape", "drape", "scrap", "scrape", "scraper", "trapeze", "therap",                    // rape / crap (scrapper)
  "cumberland", "cucumber", "circum", "accumulate", "document", "cumulative", "cumulus",  // cum (circum*/document* families)
  "uranus", "manuscript",                                                                 // anus
  "apron", "prone", "prong", "pronto", "pronoun",                                         // pron
  "thorny", "thorn", "snake", "snaked", "pizza",                                          // horny / naked / (zz→ss vs piss)
];

/** Fold every common filter-evasion trick into one comparable a-z string. */
function normalizeForProfanity(raw: string): string {
  let s = raw.toLowerCase();
  const leet: Record<string, string> = {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
    "@": "a", "$": "s", "!": "i", "|": "i",
  };
  s = s.replace(/[0134578@$!|]/g, (c) => leet[c] ?? c);
  s = s.replace(/ph/g, "f");            // phuck -> fuck
  s = s.replace(/[^a-z]/g, "");         // drop separators/digits (fuck_you -> fuckyou)
  s = s.replace(/(.)\1{2,}/g, "$1$1");  // collapse 3+ repeats to 2 (fuuuuck -> fuuck)
  return s;
}

/** Remove known-safe words from a normalized string so their embedded roots can't trip it. */
function stripSafeWords(normalized: string): string {
  let s = normalized;
  for (const safe of SAFE_WORDS) {
    if (s.includes(safe)) {
      s = s.split(safe).join(" ");
    }
  }
  return s;
}

function containsBlockedRoot(normalized: string): boolean {
  // Strip safe words FIRST (on the natural form, where Sussex/Cumberland/Scrap match intact), THEN
  // collapse evasion variants of the remainder: de-doubled (fuuck->fuck, azzhole via zz->ss below)
  // and zz->ss (azzhole->asshole). Stripping before collapsing avoids over-matching a safe word's
  // collapsed form onto an unrelated boundary (essex->esex wrongly eating "...e-sex").
  const stripped = stripSafeWords(normalized);
  const variants = [
    stripped,
    stripped.replace(/(.)\1+/g, "$1"),
    stripped.replace(/zz/g, "ss"),
  ];
  return BLOCK_ROOTS.some((root) => variants.some((v) => v.includes(root)));
}

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

  // Safe-word-stripped normalized form drives BOTH layers so a legit name that merely contains a
  // root (Dickinson, Cumberland) survives even obscenity's own gaps in its Scunthorpe allowlist.
  const stripped = stripSafeWords(normalizeForProfanity(name));

  // Layer 1: obscenity (leetspeak/homoglyph). Only honor a hit that survives safe-word removal —
  // otherwise obscenity's match was inside a legit word (it flags "dick" in Dickinson).
  const obsceneRaw = matcher.hasMatch(name) || matcher.hasMatch(lower.replace(/_/g, " "));
  if (obsceneRaw && matcher.hasMatch(stripped)) {
    return { ok: false, reason: "That name isn't allowed." };
  }
  // Layer 2: normalized root blocklist (catches obscenity's gaps + zz/ph/leet/separator evasion).
  // Pass the pre-strip normalized form — containsBlockedRoot strips per-variant itself.
  if (containsBlockedRoot(normalizeForProfanity(name))) {
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

/** Generate a name that fits the 16-char cap AND passes the profanity filter. The adjective+animal
 *  pools are clean words, but a boundary can still form an unintended root ("Electric"+"Raptor" ->
 *  "…craptor"), so we validate and retry — the generated name must never be one the filter blocks. */
export function generateKidNameClamped(): string {
  for (let i = 0; i < 12; i++) {
    const n = generateKidName();
    if (n.length <= 16 && validateChosenName(n).ok) return n;
  }
  return `Player${10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90)}`;
}
