const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AnalyticsService } = require('@faultline/reporting');
const {
  PostgresIncidentAnalyticsRepository,
} = require('@faultline/database');

const at = (minutes) =>
  new Date(Date.parse('2026-09-21T10:00:00.000Z') + minutes * 60_000).toISOString();

const record = (id, overrides = {}) => ({
  id,
  classification: 'MEMORY_EXHAUSTION',
  severity: 'WARNING',
  status: 'OPEN',
  detectedAt: at(0),
  acknowledgedAt: null,
  resolvedAt: null,
  affectedServices: [],
  ...overrides,
});

class MemoryIncidentAnalyticsRepository {
  constructor(records) {
    this.records = records;
  }

  async listIncidentMetricRecords(range) {
    const from = range.from?.getTime() ?? Number.NEGATIVE_INFINITY;
    const to = range.to?.getTime() ?? Number.POSITIVE_INFINITY;
    return this.records.filter((value) => {
      const detected = Date.parse(value.detectedAt);
      return detected >= from && detected < to;
    });
  }

  async getIncidentTrendPoints(input) {
    const records = await this.listIncidentMetricRecords(input);
    const points = new Map();
    for (const value of records) {
      const timestamp = bucketStart(value.detectedAt, input.bucket);
      const point = points.get(timestamp) ?? {
        timestamp,
        total: 0,
        critical: 0,
        resolved: 0,
      };
      point.total += 1;
      if (value.severity === 'CRITICAL') point.critical += 1;
      if (value.status === 'RESOLVED') point.resolved += 1;
      points.set(timestamp, point);
    }
    return [...points.values()].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
  }
}

function bucketStart(value, bucket) {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  if (bucket === 'hour') return date.toISOString();
  date.setUTCHours(0);
  if (bucket === 'day') return date.toISOString();
  if (bucket === 'week') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return date.toISOString();
  }
  date.setUTCDate(1);
  return date.toISOString();
}

const analytics = (records) =>
  new AnalyticsService(new MemoryIncidentAnalyticsRepository(records));

test('calculates the total incident count', async () => {
  const result = await analytics([
    record('one'),
    record('two'),
    record('three'),
  ]).getIncidentMetrics();
  assert.equal(result.totalIncidents, 3);
  assert.equal(result.openIncidents, 3);
  assert.equal(result.criticalIncidents, 0);
});

test('groups incidents by severity and counts critical incidents', async () => {
  const result = await analytics([
    record('one', { severity: 'CRITICAL' }),
    record('two', { severity: 'CRITICAL' }),
    record('three', { severity: 'HIGH' }),
  ]).getIncidentMetrics();
  assert.deepEqual(result.incidentsBySeverity, { CRITICAL: 2, HIGH: 1 });
  assert.equal(result.criticalIncidents, 2);
});

test('groups incidents by status and treats non-resolved incidents as open', async () => {
  const result = await analytics([
    record('one', { status: 'OPEN' }),
    record('two', { status: 'ACTIVE' }),
    record('three', { status: 'RESOLVED', resolvedAt: at(2) }),
  ]).getIncidentMetrics();
  assert.deepEqual(result.incidentsByStatus, { OPEN: 1, ACTIVE: 1, RESOLVED: 1 });
  assert.equal(result.openIncidents, 2);
  assert.equal(result.resolvedIncidents, 1);
});

test('excludes unresolved incidents from MTTR', async () => {
  const result = await analytics([
    record('resolved', { status: 'RESOLVED', resolvedAt: at(2) }),
    record('active', { status: 'ACTIVE', resolvedAt: at(100) }),
  ]).getIncidentMetrics();
  assert.equal(result.mttrMs, 120_000);
});

test('calculates MTTR across multiple resolved incidents', async () => {
  const result = await analytics([
    record('one', { status: 'RESOLVED', resolvedAt: at(2) }),
    record('two', { status: 'RESOLVED', resolvedAt: at(4) }),
    record('three', { status: 'ACTIVE' }),
  ]).getIncidentMetrics();
  assert.equal(result.mttrMs, 180_000);
});

test('returns null MTTR when there are no resolved incidents', async () => {
  const result = await analytics([record('one')]).getIncidentMetrics();
  assert.equal(result.mttrMs, null);
});

test('MTTA ignores incidents without a valid acknowledgement', async () => {
  const result = await analytics([
    record('one', { acknowledgedAt: at(1) }),
    record('two', { acknowledgedAt: at(3) }),
    record('missing'),
    record('before-detection', { acknowledgedAt: at(-1) }),
  ]).getIncidentMetrics();
  assert.equal(result.mttaMs, 120_000);
});

test('filters by the inclusive from and exclusive to detection timestamps', async () => {
  const result = await analytics([
    record('before', { detectedAt: at(0) }),
    record('from', { detectedAt: at(1) }),
    record('inside', { detectedAt: at(2) }),
    record('to', { detectedAt: at(3) }),
  ]).getIncidentMetrics({
    from: new Date(at(1)),
    to: new Date(at(3)),
  });
  assert.equal(result.totalIncidents, 2);
  assert.deepEqual(result.range, { from: at(1), to: at(3) });
});

test('calculates resolution rate and safely represents an empty range', async () => {
  const result = await analytics([
    record('one', { status: 'RESOLVED', resolvedAt: at(1) }),
    record('two', { status: 'RESOLVED', resolvedAt: at(2) }),
    record('three'),
    record('four'),
  ]).getIncidentMetrics();
  assert.equal(result.resolutionRate, 0.5);

  const empty = await analytics([]).getIncidentMetrics();
  assert.equal(empty.resolutionRate, 0);
  assert.equal(empty.mttrMs, null);
  assert.equal(empty.mttaMs, null);
});

test('counts each incident once per affected service', async () => {
  const result = await analytics([
    record('one', { affectedServices: ['payments', 'payments', 'database'] }),
    record('two', { affectedServices: ['payments'] }),
  ]).getIncidentMetrics();
  assert.deepEqual(result.incidentsByService, { database: 1, payments: 2 });
});

test('PostgreSQL analytics adapter reads the normalized projection in one query', async () => {
  const calls = [];
  const repository = new PostgresIncidentAnalyticsRepository({
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return {
          rows: [{
            id: 'incident-1',
            classification: 'MEMORY_EXHAUSTION',
            severity: 'CRITICAL',
            status: 'RESOLVED',
            detected_at: new Date(at(1)),
            acknowledged_at: new Date(at(2)),
            resolved_at: new Date(at(3)),
            affected_services: ['database', 'payments'],
          }],
        };
      },
    },
  });
  const range = { from: new Date(at(0)), to: new Date(at(4)) };
  assert.deepEqual(await repository.listIncidentMetricRecords(range), [{
    id: 'incident-1',
    classification: 'MEMORY_EXHAUSTION',
    severity: 'CRITICAL',
    status: 'RESOLVED',
    detectedAt: at(1),
    acknowledgedAt: at(2),
    resolvedAt: at(3),
    affectedServices: ['database', 'payments'],
  }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [at(0), at(4)]);
  assert.match(calls[0].sql, /LEFT JOIN incident_acknowledgements/);
  assert.match(calls[0].sql, /jsonb_array_elements/);
});

test('groups incident frequency into deterministic UTC day buckets', async () => {
  const service = analytics([
    record('one', { detectedAt: '2026-09-18T00:00:00.000Z' }),
    record('two', { detectedAt: '2026-09-18T23:59:59.999Z' }),
    record('three', { detectedAt: '2026-09-19T00:00:00.000Z' }),
  ]);
  assert.deepEqual(await service.getIncidentTrends({
    from: new Date('2026-09-18T00:00:00.000Z'),
    to: new Date('2026-09-20T00:00:00.000Z'),
    bucket: 'day',
  }), {
    bucket: 'day',
    points: [
      { timestamp: '2026-09-18T00:00:00.000Z', total: 2, critical: 0, resolved: 0 },
      { timestamp: '2026-09-19T00:00:00.000Z', total: 1, critical: 0, resolved: 0 },
    ],
  });
});

test('groups UTC weeks from Monday and keeps adjacent weeks separate', async () => {
  const result = await analytics([
    record('monday', { detectedAt: '2026-09-14T00:00:00.000Z' }),
    record('sunday', { detectedAt: '2026-09-20T23:59:59.999Z' }),
    record('next-monday', { detectedAt: '2026-09-21T00:00:00.000Z' }),
  ]).getIncidentTrends({
    from: new Date('2026-09-14T00:00:00.000Z'),
    to: new Date('2026-09-28T00:00:00.000Z'),
    bucket: 'week',
  });
  assert.deepEqual(result.points, [
    { timestamp: '2026-09-14T00:00:00.000Z', total: 2, critical: 0, resolved: 0 },
    { timestamp: '2026-09-21T00:00:00.000Z', total: 1, critical: 0, resolved: 0 },
  ]);
});

test('incident trends return no points for an empty range', async () => {
  const result = await analytics([]).getIncidentTrends({
    from: new Date(at(0)),
    to: new Date(at(1)),
    bucket: 'hour',
  });
  assert.deepEqual(result, { bucket: 'hour', points: [] });
});

test('incident trends count critical and resolved incidents independently', async () => {
  const result = await analytics([
    record('critical-resolved', { severity: 'CRITICAL', status: 'RESOLVED', resolvedAt: at(2) }),
    record('critical-open', { severity: 'CRITICAL' }),
    record('warning-resolved', { status: 'RESOLVED', resolvedAt: at(3) }),
  ]).getIncidentTrends({
    from: new Date(at(0)),
    to: new Date(at(60)),
    bucket: 'month',
  });
  assert.deepEqual(result.points, [{
    timestamp: '2026-09-01T00:00:00.000Z',
    total: 3,
    critical: 2,
    resolved: 2,
  }]);
});

test('incident trends reject unsupported buckets before querying', async () => {
  await assert.rejects(
    analytics([]).getIncidentTrends({
      from: new Date(at(0)),
      to: new Date(at(1)),
      bucket: 'quarter',
    }),
    /Invalid incident trend bucket/,
  );
});

test('PostgreSQL trend query groups in UTC and maps numeric counts', async () => {
  const calls = [];
  const repository = new PostgresIncidentAnalyticsRepository({
    pool: {
      async query(sql, values) {
        calls.push({ sql, values });
        return {
          rows: [{
            bucket_start_ms: String(Date.parse('2026-09-18T00:00:00.000Z')),
            total: '7',
            critical: '2',
            resolved: '6',
          }],
        };
      },
    },
  });
  const input = {
    from: new Date('2026-09-18T00:00:00.000Z'),
    to: new Date('2026-09-19T00:00:00.000Z'),
    bucket: 'day',
  };
  assert.deepEqual(await repository.getIncidentTrendPoints(input), [{
    timestamp: '2026-09-18T00:00:00.000Z',
    total: 7,
    critical: 2,
    resolved: 6,
  }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [
    input.from.toISOString(),
    input.to.toISOString(),
    'day',
    'CRITICAL',
    'RESOLVED',
  ]);
  assert.match(calls[0].sql, /AT TIME ZONE 'UTC'/);
  assert.match(calls[0].sql, /date_trunc/);
});
