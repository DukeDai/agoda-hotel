import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * File transport for the email channel.
 *
 * MVP has no SMTP and no new dependency: the rendered message is written to
 * `logs/notifications.log` next to the API package. The path is resolved from
 * the module location (works for both `src/` and the compiled `dist/`), so
 * the file always lands in the package directory and not in the caller's cwd.
 */

export const NOTIFICATION_LOG_FILENAME = 'notifications.log';

/** Walk up from this module until a package.json shows up: that is the API package. */
export function resolveApiPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function resolveNotificationLogPath(): string {
  return join(resolveApiPackageDir(), 'logs', NOTIFICATION_LOG_FILENAME);
}

/** Append one JSON line. The directory is created on demand. */
export async function appendNotificationLog(
  filePath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await appendFile(filePath, line, 'utf8');
}
