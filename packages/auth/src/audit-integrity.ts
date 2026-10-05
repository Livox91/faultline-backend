import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUDIT_INTEGRITY_ALGORITHM = 'hmac-sha256-chain-v1' as const;

export interface AuditHashInput {
  readonly id: string;
  readonly userId: string | null;
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Stable HMAC over the complete record and its predecessor. */
export function computeAuditHash(
  record: AuditHashInput,
  sequence: number,
  previousHash: string | null,
  keyId: string,
  secret: string,
): string {
  const payload = JSON.stringify(
    canonical({
      version: 1,
      algorithm: AUDIT_INTEGRITY_ALGORITHM,
      keyId,
      sequence,
      previousHash,
      record,
    }),
  );
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function auditHashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}
