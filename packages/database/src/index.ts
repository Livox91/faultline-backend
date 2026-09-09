import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import type {
  ActiveIncidentLookup,
  Incident,
  IncidentFilter,
  IncidentRepository,
} from '@faultline/incidents';

export const DATABASE = Symbol('faultline.database');
export interface Entity {
  id: string;
}
export interface Repository<T extends Entity> {
  findById(id: string): Promise<T | null>;
  save(entity: T): Promise<void>;
  deleteById(id: string): Promise<boolean>;
}
export interface Database {
  connect(): Promise<void>;
  repository<T extends Entity>(name: string): Repository<T>;
  disconnect(): Promise<void>;
}
export interface DependencyProbe {
  readonly name: string;
  ping(): Promise<void>;
}

export class PostgresConnection implements DependencyProbe {
  readonly name = 'postgresql';
  readonly pool: Pool;
  constructor(
    connectionString: string,
    options: Omit<PoolConfig, 'connectionString'> = {},
  ) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      ...options,
    });
  }
  async connect(): Promise<void> {
    await this.ping();
  }
  async ping(): Promise<void> {
    const result = await this.pool.query<{ incidents: string | null }>(
      "SELECT to_regclass('public.incidents')::text AS incidents",
    );
    if (!result.rows[0]?.incidents)
      throw new Error('PostgreSQL migrations have not been applied');
  }
  async disconnect(): Promise<void> {
    await this.pool.end();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.disconnect();
  }
}

interface AggregateRow extends QueryResultRow {
  aggregate: Incident;
}

/** PostgreSQL adapter. Aggregate and searchable child rows commit atomically. */
export class PostgresIncidentRepository implements IncidentRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async createIncident(incident: Incident): Promise<Incident> {
    return this.transaction(async (client) => {
      const anomalyId = incident.anomalies[0]!.anomalyId;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        anomalyId,
      ]);
      const duplicate = await this.findByAnomalyIdWith(client, anomalyId);
      if (duplicate) return duplicate;
      await client.query(
        'INSERT INTO clusters (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [incident.clusterId],
      );
      await client.query(
        `INSERT INTO incidents
           (id, correlation_key, cluster_id, namespace, classification, title, summary, severity, status,
            confidence, first_seen, last_seen, resolved_at, stabilization_started_at, primary_resource, aggregate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        this.values(incident),
      );
      await this.replaceChildren(client, incident);
      return incident;
    });
  }

  async updateIncident(incident: Incident): Promise<Incident> {
    return this.transaction(async (client) => {
      const locked = await client.query(
        'SELECT id FROM incidents WHERE id=$1 FOR UPDATE',
        [incident.id],
      );
      if (!locked.rowCount) throw new Error('Incident not found');
      await client.query(
        'INSERT INTO clusters (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [incident.clusterId],
      );
      await client.query(
        `UPDATE incidents SET correlation_key=$2, cluster_id=$3, namespace=$4, classification=$5,
         title=$6, summary=$7, severity=$8, status=$9, confidence=$10, first_seen=$11, last_seen=$12,
         resolved_at=$13, stabilization_started_at=$14, primary_resource=$15, aggregate=$16,
         updated_at=now() WHERE id=$1`,
        this.values(incident),
      );
      await this.replaceChildren(client, incident);
      return incident;
    });
  }

  async findActiveIncident(
    query: ActiveIncidentLookup,
  ): Promise<Incident | undefined> {
    const values: unknown[] = [query.correlationKey];
    let sql = `SELECT aggregate FROM incidents WHERE status <> 'RESOLVED' AND correlation_key=$1`;
    if (query.since) {
      values.push(query.since);
      sql += ` AND last_seen >= $${values.length}`;
    }
    if (query.classifications?.length) {
      values.push(query.classifications);
      sql += ` AND classification = ANY($${values.length})`;
    }
    return this.one(sql + ' ORDER BY last_seen DESC LIMIT 1', values);
  }
  async findByAnomalyId(anomalyId: string): Promise<Incident | undefined> {
    return this.findByAnomalyIdWith(this.connection.pool, anomalyId);
  }
  async getIncident(id: string): Promise<Incident | undefined> {
    return this.one('SELECT aggregate FROM incidents WHERE id=$1', [id]);
  }
  async resolveIncident(
    id: string,
    resolvedAt: string,
  ): Promise<Incident | undefined> {
    const current = await this.getIncident(id);
    return current
      ? this.updateIncident({ ...current, status: 'RESOLVED', resolvedAt })
      : undefined;
  }
  async listActiveIncidents(): Promise<readonly Incident[]> {
    return this.many(
      `SELECT aggregate FROM incidents WHERE status <> 'RESOLVED' ORDER BY last_seen DESC`,
      [],
    );
  }
  async listIncidents(
    filter: IncidentFilter = {},
  ): Promise<readonly Incident[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    for (const [column, value] of [
      ['cluster_id', filter.clusterId],
      ['namespace', filter.namespace],
      ['status', filter.status],
      ['severity', filter.severity],
      ['classification', filter.classification],
    ] as const)
      if (value) {
        values.push(value);
        clauses.push(`${column}=$${values.length}`);
      }
    return this.many(
      `SELECT aggregate FROM incidents${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY last_seen DESC`,
      values,
    );
  }

  private values(i: Incident): unknown[] {
    return [
      i.id,
      i.correlationKey,
      i.clusterId,
      i.namespace ?? null,
      i.classification,
      i.title,
      i.summary,
      i.severity,
      i.status,
      i.confidence,
      i.firstSeen,
      i.lastSeen,
      i.resolvedAt ?? null,
      i.stabilizationStartedAt ?? null,
      JSON.stringify(i.primaryResource),
      JSON.stringify(i),
    ];
  }
  private async replaceChildren(
    client: PoolClient,
    incident: Incident,
  ): Promise<void> {
    await client.query(
      'DELETE FROM incident_affected_resources WHERE incident_id=$1',
      [incident.id],
    );
    await client.query('DELETE FROM incident_anomalies WHERE incident_id=$1', [
      incident.id,
    ]);
    await client.query('DELETE FROM incident_evidence WHERE incident_id=$1', [
      incident.id,
    ]);
    await client.query('DELETE FROM incident_timeline WHERE incident_id=$1', [
      incident.id,
    ]);
    for (const resource of incident.affectedResources) {
      const identity =
        resource.workloadUid ??
        resource.podUid ??
        resource.node ??
        resource.workload ??
        resource.pod ??
        '';
      await client.query(
        'INSERT INTO incident_affected_resources (incident_id, resource_key, resource) VALUES ($1,$2,$3)',
        [
          incident.id,
          JSON.stringify([
            resource.clusterId,
            resource.scope,
            resource.namespace ?? '',
            identity,
            resource.container ?? '',
          ]),
          JSON.stringify(resource),
        ],
      );
    }
    for (const anomaly of incident.anomalies)
      await client.query(
        `INSERT INTO incident_anomalies (anomaly_id, incident_id, classification, severity, status, first_seen, last_seen, anomaly)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (anomaly_id) DO UPDATE SET
        classification=EXCLUDED.classification, severity=EXCLUDED.severity, status=EXCLUDED.status,
        first_seen=EXCLUDED.first_seen, last_seen=EXCLUDED.last_seen, anomaly=EXCLUDED.anomaly
        WHERE incident_anomalies.incident_id=EXCLUDED.incident_id`,
        [
          anomaly.anomalyId,
          incident.id,
          anomaly.classification,
          anomaly.severity,
          anomaly.status,
          anomaly.firstSeen,
          anomaly.lastSeen,
          JSON.stringify(anomaly),
        ],
      );
    for (const evidence of incident.evidence)
      await client.query(
        'INSERT INTO incident_evidence (incident_id, evidence_key, anomaly_id, event_id, evidence) VALUES ($1,$2,$3,$4,$5)',
        [
          incident.id,
          [
            evidence.anomalyId,
            evidence.eventId ?? '',
            evidence.timestamp,
            evidence.summary,
          ].join(':'),
          evidence.anomalyId,
          evidence.eventId ?? null,
          JSON.stringify(evidence),
        ],
      );
    for (const entry of incident.timeline)
      await client.query(
        'INSERT INTO incident_timeline (id, incident_id, occurred_at, type, anomaly_id, entry) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          entry.id,
          incident.id,
          entry.timestamp,
          entry.type,
          entry.anomalyId,
          JSON.stringify(entry),
        ],
      );
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.connection.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return structuredClone(result);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async one(
    sql: string,
    values: unknown[],
  ): Promise<Incident | undefined> {
    const result = await this.connection.pool.query<AggregateRow>(sql, values);
    return result.rows[0]?.aggregate
      ? structuredClone(result.rows[0].aggregate)
      : undefined;
  }
  private async many(sql: string, values: unknown[]): Promise<Incident[]> {
    const result = await this.connection.pool.query<AggregateRow>(sql, values);
    return result.rows.map((row) => structuredClone(row.aggregate));
  }
  private async findByAnomalyIdWith(
    client: Pick<PoolClient, 'query'> | Pool,
    anomalyId: string,
  ): Promise<Incident | undefined> {
    const result = await client.query<AggregateRow>(
      'SELECT i.aggregate FROM incidents i JOIN incident_anomalies a ON a.incident_id=i.id WHERE a.anomaly_id=$1',
      [anomalyId],
    );
    return result.rows[0]?.aggregate
      ? structuredClone(result.rows[0].aggregate)
      : undefined;
  }
}

export * from './migrations';

export * from './baselines';
