import { execSync } from 'node:child_process';

/**
 * Prepare the throwaway database used by the test suite.
 *
 * The suite runs against a REAL Postgres (not a fake) because the whole point
 * of these tests is that the transactions, the unique constraints and the
 * state machine behave the way production will.
 */
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://dukedai@localhost:5432/ota_hotel_test?schema=public';

function psql(query: string, database = 'postgres'): string {
  return execSync(`psql -d ${database} -tAc "${query}"`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).toString();
}

export default function setup(): void {
  const dbName = TEST_DB_URL.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'ota_hotel_test';

  const exists = psql(`SELECT 1 FROM pg_database WHERE datname='${dbName}'`).trim();
  if (exists !== '1') {
    execSync(`createdb "${dbName}"`, { stdio: 'pipe' });
  }

  // Push the schema into the TEST database. The DATABASE_URL is passed
  // explicitly so that this can never touch the development database.
  try {
    execSync('npx prisma db push --skip-generate --accept-data-loss --force-reset', {
      cwd: process.cwd(),
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `failed to prepare the test database (${TEST_DB_URL}):\n${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`,
    );
  }
}
