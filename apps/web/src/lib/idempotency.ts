/**
 * Idempotency key management.
 *
 * The API requires an `Idempotency-Key` on every POST and replays the first
 * response for the same key + same body. So a key must be:
 *
 *  - **stable** across retries of the *same* logical submission (a double
 *    click, a lost response, a user pressing "重试" again) — otherwise we
 *    could create two orders;
 *  - **different** for a different body (the API answers `409
 *    IDEMPOTENCY_CONFLICT` for same key + different body);
 *  - **new** for a logically new attempt, e.g. after the customer explicitly
 *    accepts a changed price.
 *
 * The store keys entries by scope ("book" / "pay" / "cancel") and compares the
 * serialised body; `rotate()` forces a fresh key for the next call in a scope.
 */

export function createIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export interface IdempotencyKeyStore {
  /** Same scope + same body → same key; otherwise a brand new key. */
  keyFor(scope: string, body: unknown): string;
  /** Force the next call in this scope to use a brand new key. */
  rotate(scope: string): void;
}

export function createIdempotencyKeyStore(): IdempotencyKeyStore {
  const entries = new Map<string, { body: string; key: string }>();

  return {
    keyFor(scope: string, body: unknown): string {
      const serialised = JSON.stringify(body ?? null);
      const existing = entries.get(scope);
      if (existing && existing.body === serialised) {
        return existing.key;
      }
      const key = createIdempotencyKey();
      entries.set(scope, { body: serialised, key });
      return key;
    },
    rotate(scope: string): void {
      entries.delete(scope);
    },
  };
}
