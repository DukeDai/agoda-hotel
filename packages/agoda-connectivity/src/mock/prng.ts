/**
 * Deterministic pseudo random numbers.
 *
 * The mock MUST be reproducible: same seed => same catalogue, same prices,
 * same drift decisions. `Math.random()` is therefore forbidden for business
 * values (it is only used by the live adapter's retry jitter, where
 * randomness is the point).
 *
 * Every random-looking business value is derived from a STRING KEY
 * (hotel id, offer id, fingerprint, ...) hashed into a seed. That makes the
 * values independent of CALL ORDER: two adapters with the same seed produce
 * the same quote for the same stay no matter in which order the calls
 * happen.
 */

/** FNV-1a 32 bit. Stable across processes and platforms. */
export function hashSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  const key = parts.join('|');
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, good enough for fixtures. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with the given probability. */
  bool(probability: number): boolean {
    return this.next() < probability;
  }

  /** Deterministic element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Cannot pick from an empty list');
    }
    const index = Math.floor(this.next() * items.length);
    return items[Math.min(index, items.length - 1)] as T;
  }

  /** A child generator derived from this one, so streams stay independent. */
  fork(label: string): SeededRandom {
    return new SeededRandom(hashSeed(this.state, label));
  }
}

/**
 * A random value derived from a key: stable for the same key, independent
 * of any call order.
 */
export function seededValue<T>(key: string, produce: (rng: SeededRandom) => T): T {
  return produce(new SeededRandom(hashSeed(key)));
}

/** A uniform float in [0, 1) derived from a key. */
export function seededUnit(key: string): number {
  return new SeededRandom(hashSeed(key)).next();
}
