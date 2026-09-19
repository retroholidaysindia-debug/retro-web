/**
 * Name normalisation and cross-source place matching.
 *
 * The four sources spell the same place differently ("Cochin"/"Kochi",
 * "Ha Noi"/"Hanoi", "Smarkand"/"Samarkand", "Charwak Lake"/"Charvak Reservoir").
 * Rather than fuzzy-matching at runtime, the ETL resolves every name once and
 * records how it did so, then writes the result out for review.
 */

/** Case/accent/punctuation-insensitive comparison key. */
export function normalise(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019'`\u00b4]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** URL-safe identifier. */
export function slugify(s: string): string {
  return normalise(s).replace(/\s+/g, "-");
}

/**
 * Consonant skeleton — collapses transliteration vowel drift
 * ("Smarkand"/"Samarkand", "Nauwaraeliya"/"Nuwaraeliya").
 */
function skeleton(s: string): string {
  return normalise(s).replace(/\s+/g, "").replace(/[aeiou]/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Common suffixes that carry no identity ("London , UK" -> "London"). */
const NOISE_SUFFIX =
  /\s*[,(]\s*(uk|u\.k\.|united kingdom|south korea|egypt|india|japan|vietnam|thailand)\s*\)?\s*$/i;

/** Generic geographic nouns that shouldn't drive a match on their own. */
const GENERIC_WORD =
  /\b(national park|park|island|islands|lake|city|valley|beach|reservoir|pass|temple|falls|waterfalls|province|region|district|state)\b/g;

function stripNoise(s: string): string {
  return normalise(s.replace(NOISE_SUFFIX, ""));
}

function core(s: string): string {
  return stripNoise(s).replace(GENERIC_WORD, " ").replace(/\s+/g, " ").trim();
}

export type MatchHow = "override" | "exact" | "noise" | "core" | "skeleton" | "edit1" | "edit2";

export type MatchResult<T> = {
  value: T;
  how: MatchHow;
  /** The candidate's own name, for reporting. */
  matched: string;
};

export type Candidate<T> = { name: string; value: T };

/**
 * Resolves `query` against `candidates` using progressively looser rules, and
 * reports which rule fired so borderline matches can be audited.
 *
 * Deliberately conservative: an ambiguous looser match (more than one candidate
 * at the same tier) is treated as no match rather than an arbitrary pick.
 */
export class Matcher<T> {
  private readonly byExact = new Map<string, Candidate<T>[]>();
  private readonly byNoise = new Map<string, Candidate<T>[]>();
  private readonly byCore = new Map<string, Candidate<T>[]>();
  private readonly bySkeleton = new Map<string, Candidate<T>[]>();

  constructor(
    candidates: Candidate<T>[],
    /** Hand-maintained `sourceName -> candidateName` overrides. */
    private readonly overrides: Record<string, string> = {},
  ) {
    const push = (m: Map<string, Candidate<T>[]>, k: string, c: Candidate<T>) => {
      if (!k) return;
      const list = m.get(k);
      if (list) list.push(c);
      else m.set(k, [c]);
    };
    for (const c of candidates) {
      push(this.byExact, normalise(c.name), c);
      push(this.byNoise, stripNoise(c.name), c);
      push(this.byCore, core(c.name), c);
      push(this.bySkeleton, skeleton(c.name), c);
    }
  }

  private unique(m: Map<string, Candidate<T>[]>, key: string): Candidate<T> | null {
    const hits = m.get(key);
    if (!hits?.length) return null;
    if (hits.length > 1) {
      // Ambiguous only if they're genuinely different candidates.
      const distinct = new Set(hits.map((h) => h.name));
      if (distinct.size > 1) return null;
    }
    return hits[0];
  }

  match(query: string): MatchResult<T> | null {
    const override = this.overrides[query] ?? this.overrides[normalise(query)];
    if (override) {
      const hit = this.unique(this.byExact, normalise(override));
      if (hit) return { value: hit.value, how: "override", matched: hit.name };
    }

    const tiers: [Map<string, Candidate<T>[]>, string, MatchHow][] = [
      [this.byExact, normalise(query), "exact"],
      [this.byNoise, stripNoise(query), "noise"],
      [this.byCore, core(query), "core"],
      [this.bySkeleton, skeleton(query), "skeleton"],
    ];
    for (const [map, key, how] of tiers) {
      const hit = this.unique(map, key);
      if (hit) return { value: hit.value, how, matched: hit.name };
    }

    // Last resort: small edit distance, but only against a unique best result
    // and only for names long enough that 1-2 edits are meaningful.
    const q = stripNoise(query);
    if (q.length < 5) return null;
    let best: { c: Candidate<T>; d: number }[] = [];
    for (const [key, list] of this.byNoise) {
      const d = levenshtein(key, q);
      if (d <= 2) for (const c of list) best.push({ c, d });
    }
    if (!best.length) return null;
    best = best.sort((a, b) => a.d - b.d);
    const top = best.filter((b) => b.d === best[0].d);
    const distinct = new Set(top.map((t) => t.c.name));
    if (distinct.size > 1) return null;
    return {
      value: top[0].c.value,
      how: best[0].d === 1 ? "edit1" : "edit2",
      matched: top[0].c.name,
    };
  }
}
