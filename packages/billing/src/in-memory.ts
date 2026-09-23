import { randomUUID } from 'node:crypto';
import type {
  NewSubscription,
  ProcessedEventRepository,
  Subscription,
  SubscriptionChanges,
  SubscriptionRepository,
} from './subscriptions';

/**
 * Test doubles, matching the PostgreSQL adapters' contract.
 *
 * They exist so provisioning - the part that must never double-create an account - can
 * be exercised without a database, exactly as the incident and telemetry packages
 * already do for their own repositories.
 */
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly rows = new Map<string, Subscription>();

  async createForCheckout(input: NewSubscription): Promise<Subscription> {
    if (input.checkoutSessionId) {
      const existing = await this.findByCheckoutSession(input.checkoutSessionId);
      // Mirrors the unique constraint: the second caller reads the first one's row.
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const row: Subscription = {
      id: randomUUID(),
      userId: null,
      email: input.email.trim().toLowerCase(),
      paymentProvider: input.paymentProvider,
      paymentProviderCustomerId: input.paymentProviderCustomerId ?? null,
      paymentProviderSubscriptionId:
        input.paymentProviderSubscriptionId ?? null,
      checkoutSessionId: input.checkoutSessionId ?? null,
      plan: input.plan,
      status: input.status,
      provisioningStatus: input.provisioningStatus ?? 'pending',
      provisioningError: null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findByCheckoutSession(
    sessionId: string,
  ): Promise<Subscription | undefined> {
    return [...this.rows.values()].find(
      (row) => row.checkoutSessionId === sessionId,
    );
  }

  async findByProviderSubscriptionId(
    id: string,
  ): Promise<Subscription | undefined> {
    return [...this.rows.values()].find(
      (row) => row.paymentProviderSubscriptionId === id,
    );
  }

  async findByEmail(email: string): Promise<Subscription | undefined> {
    const wanted = email.trim().toLowerCase();
    return [...this.rows.values()].find((row) => row.email === wanted);
  }

  async findByUserId(userId: string): Promise<Subscription | undefined> {
    const mine = [...this.rows.values()].filter((row) => row.userId === userId);
    // Same ordering as the SQL adapter: active first, then newest.
    return mine.sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        b.createdAt.localeCompare(a.createdAt),
    )[0];
  }

  async findById(id: string): Promise<Subscription | undefined> {
    return this.rows.get(id);
  }

  async update(
    id: string,
    changes: SubscriptionChanges,
  ): Promise<Subscription | undefined> {
    const existing = this.rows.get(id);
    if (!existing) return undefined;
    const updated: Subscription = {
      ...existing,
      ...(changes.userId !== undefined ? { userId: changes.userId } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.provisioningStatus !== undefined
        ? { provisioningStatus: changes.provisioningStatus }
        : {}),
      ...(changes.provisioningError !== undefined
        ? { provisioningError: changes.provisioningError }
        : {}),
      ...(changes.paymentProviderSubscriptionId !== undefined
        ? {
            paymentProviderSubscriptionId:
              changes.paymentProviderSubscriptionId,
          }
        : {}),
      ...(changes.paymentProviderCustomerId !== undefined
        ? { paymentProviderCustomerId: changes.paymentProviderCustomerId }
        : {}),
      ...(changes.startDate !== undefined
        ? { startDate: changes.startDate }
        : {}),
      ...(changes.endDate !== undefined ? { endDate: changes.endDate } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async listUnprovisioned(): Promise<readonly Subscription[]> {
    return [...this.rows.values()].filter(
      (row) => row.provisioningStatus !== 'provisioned',
    );
  }
}

export class InMemoryProcessedEventRepository
  implements ProcessedEventRepository
{
  private readonly seen = new Map<string, string>();

  async claim(eventId: string, eventType: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, eventType);
    return true;
  }

  async release(eventId: string): Promise<void> {
    this.seen.delete(eventId);
  }
}
