/**
 * Deterministic PRNG (mulberry32). The seed must produce byte-identical
 * schedules, scores and picks on every run so that fixtures are reproducible
 * and "seed twice, get the same season" is a real property rather than a hope.
 *
 * Never use Math.random anywhere in the seed.
 */
export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("pick() called on an empty array");
      return item;
    },
    bool: () => next() < 0.5,
    shuffle<T>(items: readonly T[]): T[] {
      // Fisher-Yates, driven entirely by the seeded stream.
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        const a = copy[i] as T;
        const b = copy[j] as T;
        copy[i] = b;
        copy[j] = a;
      }
      return copy;
    },
  };
}
