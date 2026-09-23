import { randomUUID } from 'node:crypto';
import type {
  NewSubscription,
  PlanId,
  ProcessedEventRepository,
  ProvisioningStatus,
  Subscription,
  SubscriptionChanges,
  SubscriptionRepository,
  SubscriptionStatus,
} from '@faultline/billing';
import type { PostgresConnection } from './index';

interface SubscriptionRow {
  id: string;
  user_id: string | null;
  email: string;
  payment_provider: string;
  payment_provider_customer_id: string | null;
  payment_provider_subscription_id: string | null;
  checkout_session_id: string | null;
  plan: string;
  status: string;
  provisioning_status: string;
  provisioning_error: string | null;
  start_date: Date | null;
  end_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toSubscription = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  userId: row.user_id,
  email: row.email,
  paymentProvider: row.payment_provider,
  paymentProviderCustomerId: row.payment_provider_customer_id,
  paymentProviderSubscriptionId: row.payment_provider_subscription_id,
  checkoutSessionId: row.checkout_session_id,
  plan: row.plan as PlanId,
  status: row.status as SubscriptionStatus,
  provisioningStatus: row.provisioning_status as ProvisioningStatus,
  provisioningError: row.provisioning_error,
  startDate: row.start_date?.toISOString() ?? null,
  endDate: row.end_date?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const columns = `id, user_id, email, payment_provider, payment_provider_customer_id,
  payment_provider_subscription_id, checkout_session_id, plan, status,
  provisioning_status, provisioning_error, start_date, end_date, created_at, updated_at`;

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly connection: PostgresConnection) {}

  /**
   * Inserts, or returns the row already there for this checkout session.
   *
   * `ON CONFLICT DO NOTHING` plus a read-back rather than `DO UPDATE`: if a redelivered
   * webhook lost the race, the winner's row is already correct and the loser must not
   * overwrite fields that provisioning has since filled in. The unique index on
   * `checkout_session_id` is what makes the race safe at all.
   */
  async createForCheckout(input: NewSubscription): Promise<Subscription> {
    const result = await this.connection.pool.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (id, email, payment_provider, payment_provider_customer_id,
          payment_provider_subscription_id, checkout_session_id, plan, status,
          provisioning_status, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz)
       ON CONFLICT (checkout_session_id) WHERE checkout_session_id IS NOT NULL
         DO NOTHING
       RETURNING ${columns}`,
      [
        randomUUID(),
        input.email.trim().toLowerCase(),
        input.paymentProvider,
        input.paymentProviderCustomerId ?? null,
        input.paymentProviderSubscriptionId ?? null,
        input.checkoutSessionId ?? null,
        input.plan,
        input.status,
        input.provisioningStatus ?? 'pending',
        input.startDate ?? null,
        input.endDate ?? null,
      ],
    );
    if (result.rows[0]) return toSubscription(result.rows[0]);

    const existing = input.checkoutSessionId
      ? await this.findByCheckoutSession(input.checkoutSessionId)
      : undefined;
    if (existing) return existing;
    throw new Error('Subscription insert conflicted but no row was found');
  }

  async findByCheckoutSession(
    sessionId: string,
  ): Promise<Subscription | undefined> {
    return this.one(`checkout_session_id = $1`, [sessionId]);
  }

  async findByProviderSubscriptionId(
    id: string,
  ): Promise<Subscription | undefined> {
    return this.one(`payment_provider_subscription_id = $1`, [id]);
  }

  async findByEmail(email: string): Promise<Subscription | undefined> {
    return this.one(`lower(email) = lower($1)`, [email.trim()], 'created_at DESC');
  }

  async findByUserId(userId: string): Promise<Subscription | undefined> {
    if (!isUuidLike(userId)) return undefined;
    // An account that cancelled and re-subscribed has two rows; the live one decides
    // what it may reach, so `active` sorts ahead of merely recent. Served by
    // `subscriptions_user`.
    return this.one(
      `user_id = $1`,
      [userId],
      `(status = 'active') DESC, created_at DESC`,
    );
  }

  async findById(id: string): Promise<Subscription | undefined> {
    if (!isUuidLike(id)) return undefined;
    return this.one(`id = $1`, [id]);
  }

  async update(
    id: string,
    changes: SubscriptionChanges,
  ): Promise<Subscription | undefined> {
    if (!isUuidLike(id)) return undefined;
    const result = await this.connection.pool.query<SubscriptionRow>(
      `UPDATE subscriptions SET
         user_id = COALESCE($2, user_id),
         status = COALESCE($3, status),
         provisioning_status = COALESCE($4, provisioning_status),
         -- Cleared explicitly on success, so a stale reason cannot outlive the failure
         -- it described; $6 carries the "please clear it" flag.
         provisioning_error = CASE WHEN $6::boolean THEN $5 ELSE provisioning_error END,
         payment_provider_subscription_id =
           COALESCE($7, payment_provider_subscription_id),
         payment_provider_customer_id = COALESCE($8, payment_provider_customer_id),
         start_date = COALESCE($9::timestamptz, start_date),
         end_date = COALESCE($10::timestamptz, end_date),
         updated_at = now()
       WHERE id = $1
       RETURNING ${columns}`,
      [
        id,
        changes.userId ?? null,
        changes.status ?? null,
        changes.provisioningStatus ?? null,
        changes.provisioningError ?? null,
        changes.provisioningError !== undefined,
        changes.paymentProviderSubscriptionId ?? null,
        changes.paymentProviderCustomerId ?? null,
        changes.startDate ?? null,
        changes.endDate ?? null,
      ],
    );
    return result.rows[0] ? toSubscription(result.rows[0]) : undefined;
  }

  async listUnprovisioned(): Promise<readonly Subscription[]> {
    const result = await this.connection.pool.query<SubscriptionRow>(
      `SELECT ${columns} FROM subscriptions
        WHERE provisioning_status <> 'provisioned'
        ORDER BY created_at`,
    );
    return result.rows.map(toSubscription);
  }

  private async one(
    where: string,
    values: unknown[],
    order = 'created_at',
  ): Promise<Subscription | undefined> {
    const result = await this.connection.pool.query<SubscriptionRow>(
      `SELECT ${columns} FROM subscriptions WHERE ${where} ORDER BY ${order} LIMIT 1`,
      values,
    );
    return result.rows[0] ? toSubscription(result.rows[0]) : undefined;
  }
}

/**
 * The events already acted upon.
 *
 * `claim` is an insert, not a read-then-write: checking for the id and then inserting
 * it leaves a window in which two concurrent deliveries both see nothing and both
 * proceed. Letting the primary key reject the second one closes that window in the
 * database, where the concurrency actually is.
 */
export class PostgresProcessedEventRepository
  implements ProcessedEventRepository
{
  constructor(private readonly connection: PostgresConnection) {}

  async claim(eventId: string, eventType: string): Promise<boolean> {
    const result = await this.connection.pool.query(
      `INSERT INTO processed_payment_events (event_id, event_type)
       VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Gives the claim back when handling threw.
   *
   * Without this, a transient failure - the database briefly unavailable while creating
   * the user - would mark the event permanently handled and the provider's retry would
   * be ignored, turning a recoverable blip into a paid customer with no account.
   */
  async release(eventId: string): Promise<void> {
    await this.connection.pool.query(
      `DELETE FROM processed_payment_events WHERE event_id = $1`,
      [eventId],
    );
  }
}

const uuidLike =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidLike = (value: unknown): value is string =>
  typeof value === 'string' && uuidLike.test(value);
