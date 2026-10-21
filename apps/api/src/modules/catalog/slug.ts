/**
 * URL-safe slugs for hotels.
 *
 * A slug appears in a public URL, so it has to be stable: the same hotel must
 * always end up with the same slug, and two hotels must never share one.
 *
 * Everything here is a pure function so the rule can be unit tested without a
 * database.
 */

const MAX_SLUG_LENGTH = 80;

/**
 * Fold a name down to `[a-z0-9-]`.
 *
 * Accents are stripped (NFKD + combining marks), everything that is not an
 * ASCII letter or digit becomes a dash, and leading/trailing dashes are cut.
 * A name written entirely in a non-latin script therefore folds to the empty
 * string, which is why every call site passes a fallback.
 */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

function trimLength(value: string): string {
  return value.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
}

/**
 * Build the slug of a hotel.
 *
 * `fallback` is used when the name has no usable characters (e.g. a purely
 * Chinese name). It falls back to the supplier hotel id, which is always
 * ASCII and unique.
 */
export function slugify(name: string, fallback: string): string {
  const base = trimLength(fold(name ?? ''));
  if (base) return base;
  const fb = trimLength(fold(fallback ?? ''));
  return fb || 'hotel';
}

/** Deterministic short hash, used as the last-resort slug suffix. */
function stableHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Make a slug unique.
 *
 * `isTaken` answers "is this slug already used by ANOTHER hotel?". The
 * supplier hotel id is used as the suffix, so the result stays deterministic:
 * re-running the sync never produces a different slug for the same hotel.
 */
export async function uniqueSlug(
  base: string,
  supplierHotelId: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(base))) return base;

  const scoped = `${base}-${slugify(supplierHotelId, 'x')}`;
  if (!(await isTaken(scoped))) return scoped;

  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${scoped}-${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  return `${scoped}-${stableHash(supplierHotelId)}`;
}
