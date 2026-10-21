import { createHash, randomBytes, randomUUID } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, len: number): string {
  let out = '';
  let t = ms;
  for (let i = len - 1; i >= 0; i -= 1) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += CROCKFORD[(bytes[i] as number) % 32];
  }
  return out;
}

/**
 * ULID: lexicographically sortable, collision resistant, URL safe.
 * Sorting by id == sorting by creation time, which keeps indexes cheap.
 */
export function newId(prefix?: string): string {
  const ulid = `${encodeTime(Date.now(), 10)}${encodeRandom(16)}`;
  return prefix ? `${prefix}_${ulid}` : ulid;
}

export function newUuid(): string {
  return randomUUID();
}

/** Human-facing order number, e.g. OTA-20261020-8F3KQ2. */
export function newOrderNo(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `OTA-${y}${m}${d}-${encodeRandom(6)}`;
}

/**
 * Deterministic fingerprint of an object. Used to prove that the
 * Search / Precheck / Book requests carry identical parameters
 * (Agoda explicitly rejects "parameter drift").
 */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
