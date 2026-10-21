import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, fingerprint } from '@ota/core';

/**
 * Idempotency for mutating endpoints.
 *
 * The contract: the SAME key + the SAME request body replays the FIRST
 * response. The SAME key + a DIFFERENT body is a client bug and is rejected
 * with IDEMPOTENCY_CONFLICT rather than silently returning the wrong result.
 *
 * The record is written in the same transaction as the business write, so a
 * crash between "capture payment" and "write response" cannot produce a
 * double charge.
 */
export interface IdempotencyOptions {
  prisma: PrismaClient;
  key: string;
  scope: string;
  /** The request payload; used to detect key reuse with a different body. */
  request: unknown;
  ttlSeconds?: number;
}

export interface IdempotencyReplay {
  replayed: true;
  status: number;
  body: unknown;
}

export async function beginIdempotent(
  options: IdempotencyOptions,
): Promise<IdempotencyReplay | null> {
  const { prisma, key, scope, request } = options;
  const requestHash = fingerprint(request);
  const ttl = options.ttlSeconds ?? 24 * 3600;

  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (existing) {
    if (existing.scope !== scope) {
      throw new AppError('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" was used for scope "${existing.scope}"`, {
        details: { key, expectedScope: existing.scope, gotScope: scope },
      });
    }
    if (existing.requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" was reused with a different payload`, {
        details: { key, scope },
      });
    }
    if (existing.state === 'COMPLETED') {
      return { replayed: true, status: existing.responseStatus ?? 200, body: existing.responseBody };
    }
    if (existing.state === 'IN_PROGRESS') {
      throw new AppError('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" is still in progress`, {
        details: { key, scope },
      });
    }
    // FAILED state: allow a fresh attempt with the same key.
    await prisma.idempotencyRecord.update({
      where: { key },
      data: { state: 'IN_PROGRESS', responseStatus: null, responseBody: undefined },
    });
    return null;
  }

  try {
    await prisma.idempotencyRecord.create({
      data: {
        key,
        scope,
        requestHash,
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
    });
  } catch (err) {
    // Unique violation: another request with the same key won the race.
    throw new AppError('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" is already in use`, {
      details: { key, scope },
      cause: err,
    });
  }
  return null;
}

export async function completeIdempotent(
  tx: Prisma.TransactionClient | PrismaClient,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await tx.idempotencyRecord.update({
    where: { key },
    data: {
      state: 'COMPLETED',
      responseStatus: status,
      responseBody: body as Prisma.InputJsonValue,
    },
  });
}

export async function failIdempotent(
  prisma: PrismaClient,
  key: string,
  message: string,
): Promise<void> {
  await prisma.idempotencyRecord
    .update({
      where: { key },
      data: { state: 'FAILED', responseStatus: null, responseBody: { error: message } },
    })
    .catch(() => undefined);
}

/** Express-style helper for Fastify routes. */
export function idempotencyKeyFrom(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  throw new AppError('VALIDATION_ERROR', 'Idempotency-Key header is required', {
    details: { header: 'Idempotency-Key' },
  });
}
