const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AnalyticsService,
  CurrentApplicationHealthProvider,
  SystemSummaryService,
} = require('@faultline/reporting');

const iso = (value) => new Date(value).toISOString();
const period = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-10-01T00:00:00.000Z'),
};

const record = (id, overrides = {}) => ({
  id,
  classification: 'MEMORY_EXHAUSTION',
  severity: 'WARNING',
  status: 'OPEN',
  detectedAt: '2026-09-18T10:00:00.000Z',
  acknowledgedAt: null,
  resolvedAt: null,
  affectedServices: [],
  ...overrides,
});

class SummaryRepository {
  constructor(records) {
    this.records = records;
  }

  inRange(input) {
    return this.records.filter((value) => {
      const detected = Date.parse(value.detectedAt);
      return detected >= input.from.getTime() && detected < input.to.getTime();
    });
  }

  async listIncidentMetricRecords(input) {
    return this.inRange(input);
  }

  async getIncidentTrendPoints(input) {
    const points = new Map();
    for (const value of this.inRange(input)) {
      const date = new Date(value.detectedAt);
      date.setUTCHours(0, 0, 0, 0);
      const timestamp = date.toISOString();
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

const summary = (records, options = {}) =>
  new SystemSummaryService(
    new AnalyticsService(new SummaryRepository(records)),
    {
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      ...options,
    },
  );

test('generates a complete system summary from analytics and readiness', async () => {
  const service = summary([
    record('one', {
      severity: 'CRITICAL',
      status: 'RESOLVED',
      acknowledgedAt: '2026-09-18T10:01:00.000Z',
      resolvedAt: '2026-09-18T10:04:00.000Z',
      affectedServices: ['payments'],
    }),
    record('two', {
      classification: 'APPLICATION_DEPENDENCY_FAILURE',
      status: 'RESOLVED',
      detectedAt: '2026-09-19T11:00:00.000Z',
      acknowledgedAt: '2026-09-19T11:03:00.000Z',
      resolvedAt: '2026-09-19T11:06:00.000Z',
      affectedServices: ['payments', 'database'],
    }),
    record('three', {
      classification: 'APPLICATION_DEPENDENCY_FAILURE',
      status: 'ACTIVE',
      detectedAt: '2026-09-19T12:00:00.000Z',
      affectedServices: ['database'],
    }),
  ], {
    health: {
      async getSystemHealth() {
        return [
          { application: 'api', status: 'ok', uptime: 100 },
          { application: 'processor', status: 'degraded', uptime: 100 },
          { application: 'storage', status: 'unavailable', uptime: 100 },
        ];
      },
    },
  });

  const result = await service.generateSystemSummary(period);
  assert.equal(result.generatedAt, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(result.period, {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
  });
  assert.deepEqual(result.health, {
    available: true,
    overallStatus: 'unavailable',
    healthyServices: 1,
    degradedServices: 1,
    unhealthyServices: 1,
  });
  assert.deepEqual(result.incidents, {
    total: 3,
    critical: 1,
    resolved: 2,
    unresolved: 1,
  });
  assert.deepEqual(result.performance, { mttrMs: 300000, mttaMs: 120000 });
  assert.deepEqual(result.topAffectedServices, [
    { service: 'database', incidentCount: 2 },
    { service: 'payments', incidentCount: 2 },
  ]);
  assert.deepEqual(result.commonIncidentCategories, [
    { classification: 'APPLICATION_DEPENDENCY_FAILURE', incidentCount: 2 },
    { classification: 'MEMORY_EXHAUSTION', incidentCount: 1 },
  ]);
  assert.equal(result.trends.length, 2);
});

test('generates an empty incident summary without zeroing unavailable averages', async () => {
  const result = await summary([]).generateSystemSummary(period);
  assert.deepEqual(result.incidents, {
    total: 0,
    critical: 0,
    resolved: 0,
    unresolved: 0,
  });
  assert.deepEqual(result.performance, { mttrMs: null, mttaMs: null });
  assert.deepEqual(result.topAffectedServices, []);
  assert.deepEqual(result.commonIncidentCategories, []);
  assert.deepEqual(result.trends, []);
});

test('represents unavailable health explicitly without failing the summary', async () => {
  const result = await summary([record('one')], {
    health: { async getSystemHealth() { throw new Error('probe failed'); } },
  }).generateSystemSummary(period);
  assert.deepEqual(result.health, {
    available: false,
    overallStatus: 'unavailable',
    healthyServices: 0,
    degradedServices: 0,
    unhealthyServices: 0,
  });
  assert.equal(result.incidents.total, 1);
});

test('applies the requested date range to summary metrics and trends', async () => {
  const result = await summary([
    record('before', { detectedAt: iso('2026-08-31T23:59:59.999Z') }),
    record('inside', { detectedAt: iso('2026-09-01T00:00:00.000Z') }),
    record('end', { detectedAt: iso('2026-10-01T00:00:00.000Z') }),
  ]).generateSystemSummary(period);
  assert.equal(result.incidents.total, 1);
  assert.equal(result.trends.reduce((sum, point) => sum + point.total, 0), 1);
});

test('ranks top affected services by incident count with deterministic ties', async () => {
  const result = await summary([
    record('one', { affectedServices: ['payments', 'database'] }),
    record('two', { affectedServices: ['payments'] }),
    record('three', { affectedServices: ['search'] }),
  ]).generateSystemSummary(period);
  assert.deepEqual(result.topAffectedServices, [
    { service: 'payments', incidentCount: 2 },
    { service: 'database', incidentCount: 1 },
    { service: 'search', incidentCount: 1 },
  ]);
});

test('adapts the existing application readiness service', async () => {
  const readiness = { application: 'api', status: 'degraded', uptime: 42 };
  const provider = new CurrentApplicationHealthProvider({
    async getReadinessReport() { return readiness; },
  });
  assert.deepEqual(await provider.getSystemHealth(), [readiness]);
});

test('current application health preserves an actual unavailable readiness state', async () => {
  const readiness = { application: 'api', status: 'unavailable', uptime: 42 };
  const provider = new CurrentApplicationHealthProvider({
    async getReadinessReport() { return readiness; },
  });
  assert.deepEqual(await provider.getSystemHealth(), [readiness]);
});
