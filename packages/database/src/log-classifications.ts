import type { QueryResultRow } from 'pg';
import type {
  LogClassification,
  LogClassificationRepository,
  LogClassificationResult,
  LogClassifierType,
  LogPatternAggregate,
} from '@faultline/log-classification';
import type { PostgresConnection } from './index';

interface ResultRow extends QueryResultRow {
  event_id: string;
  classification: string;
  confidence: number;
  classifier_type: string;
  pattern_id: string;
  model_version: string;
  occurred_at: Date;
  evidence: LogClassificationResult['evidence'];
}

interface PatternRow extends QueryResultRow {
  pattern_id: string;
  classification: string;
  occurrence_count: string;
  first_seen: Date;
  last_seen: Date;
  affected_pods: string[];
}

export class PostgresLogClassificationRepository implements LogClassificationRepository {
  constructor(private readonly connection: PostgresConnection) {}

  async save(
    result: LogClassificationResult,
    context: {
      clusterId: string;
      namespace?: string;
      workload?: string;
      pod?: string;
      aggregationWindowMs: number;
    },
  ): Promise<LogPatternAggregate> {
    const client = await this.connection.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO clusters (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [context.clusterId],
      );
      const inserted = await client.query(
        `INSERT INTO log_classifications
          (event_id, classification, confidence, classifier_type, pattern_id, model_version, occurred_at, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          result.eventId,
          result.classification,
          result.confidence,
          result.classifierType,
          result.patternId,
          result.modelVersion,
          result.timestamp,
          JSON.stringify(result.evidence),
        ],
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO log_pattern_aggregates
            (pattern_id, cluster_id, namespace, workload, classification, occurrence_count, first_seen, last_seen, affected_pods)
           VALUES ($1,$2,$3,$4,$5,1,$6,$6,$7)
           ON CONFLICT (pattern_id) DO UPDATE SET
             occurrence_count=CASE
               WHEN EXCLUDED.last_seen - log_pattern_aggregates.last_seen > ($8::double precision * interval '1 millisecond') THEN 1
               ELSE log_pattern_aggregates.occurrence_count+1
             END,
             first_seen=CASE
               WHEN EXCLUDED.last_seen - log_pattern_aggregates.last_seen > ($8::double precision * interval '1 millisecond') THEN EXCLUDED.first_seen
               ELSE LEAST(log_pattern_aggregates.first_seen, EXCLUDED.first_seen)
             END,
             last_seen=GREATEST(log_pattern_aggregates.last_seen, EXCLUDED.last_seen),
             affected_pods=CASE
               WHEN EXCLUDED.last_seen - log_pattern_aggregates.last_seen > ($8::double precision * interval '1 millisecond') THEN EXCLUDED.affected_pods
               ELSE (
                 SELECT ARRAY(SELECT DISTINCT pod FROM unnest(log_pattern_aggregates.affected_pods || EXCLUDED.affected_pods) pod ORDER BY pod)
               )
             END`,
          [
            result.patternId,
            context.clusterId,
            context.namespace ?? null,
            context.workload ?? null,
            result.classification,
            result.timestamp,
            context.pod ? [context.pod] : [],
            context.aggregationWindowMs,
          ],
        );
      }
      const aggregate = await client.query<PatternRow>(
        'SELECT * FROM log_pattern_aggregates WHERE pattern_id=$1',
        [result.patternId],
      );
      await client.query('COMMIT');
      return mapPattern(aggregate.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(eventId: string): Promise<LogClassificationResult | undefined> {
    const result = await this.connection.pool.query<ResultRow>(
      'SELECT * FROM log_classifications WHERE event_id=$1',
      [eventId],
    );
    const row = result.rows[0];
    return row
      ? {
          eventId: row.event_id,
          classification: row.classification as LogClassification,
          confidence: row.confidence,
          classifierType: row.classifier_type as LogClassifierType,
          patternId: row.pattern_id,
          modelVersion: row.model_version,
          timestamp: row.occurred_at.toISOString(),
          evidence: row.evidence,
        }
      : undefined;
  }

  async getPattern(
    patternId: string,
  ): Promise<LogPatternAggregate | undefined> {
    const result = await this.connection.pool.query<PatternRow>(
      'SELECT * FROM log_pattern_aggregates WHERE pattern_id=$1',
      [patternId],
    );
    return result.rows[0] ? mapPattern(result.rows[0]) : undefined;
  }
}

function mapPattern(row: PatternRow): LogPatternAggregate {
  return {
    patternId: row.pattern_id,
    classification: row.classification as LogClassification,
    count: Number(row.occurrence_count),
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
    affectedPods: row.affected_pods,
  };
}
