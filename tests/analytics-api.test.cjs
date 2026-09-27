require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  AnalyticsService,
  SystemSummaryService,
} = require('@faultline/reporting');
const {
  IncidentAnalyticsController,
  SystemSummaryController,
} = require('../apps/api/dist/analytics.controller');

const from = '2026-09-01T00:00:00.000Z';
const to = '2026-10-01T00:00:00.000Z';

async function harness() {
  const calls = [];
  const metrics = {
    range: { from, to },
    totalIncidents: 2,
    openIncidents: 1,
    resolvedIncidents: 1,
    criticalIncidents: 1,
    incidentsBySeverity: { CRITICAL: 1, WARNING: 1 },
    incidentsByStatus: { ACTIVE: 1, RESOLVED: 1 },
    incidentsByClassification: { MEMORY_EXHAUSTION: 2 },
    incidentsByService: { payments: 2 },
    resolutionRate: 0.5,
    mttrMs: 120000,
    mttaMs: 30000,
  };
  const trends = {
    bucket: 'day',
    points: [{ timestamp: from, total: 2, critical: 1, resolved: 1 }],
  };
  const summary = {
    generatedAt: to,
    period: { from, to },
    health: {
      available: false,
      overallStatus: 'unavailable',
      healthyServices: 0,
      degradedServices: 0,
      unhealthyServices: 0,
    },
    incidents: { total: 2, critical: 1, resolved: 1, unresolved: 1 },
    performance: { mttrMs: 120000, mttaMs: 30000 },
    topAffectedServices: [{ service: 'payments', incidentCount: 2 }],
    commonIncidentCategories: [
      { classification: 'MEMORY_EXHAUSTION', incidentCount: 2 },
    ],
    trends: trends.points,
  };
  const analytics = {
    async getIncidentMetrics(input) {
      calls.push({ operation: 'metrics', input });
      return metrics;
    },
    async getIncidentTrends(input) {
      calls.push({ operation: 'trends', input });
      return trends;
    },
  };
  const summaries = {
    async generateSystemSummary(input) {
      calls.push({ operation: 'summary', input });
      return summary;
    },
  };
  class AnalyticsApiModule {}
  Module({
    controllers: [IncidentAnalyticsController, SystemSummaryController],
    providers: [
      { provide: AnalyticsService, useValue: analytics },
      { provide: SystemSummaryService, useValue: summaries },
    ],
  })(AnalyticsApiModule);
  const app = await NestFactory.create(AnalyticsApiModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl(), calls, metrics, trends, summary };
}

test('analytics and system summary endpoints return existing service DTOs', async () => {
  const h = await harness();
  try {
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const metricsResponse = await fetch(`${h.base}/analytics/incidents?${query}`);
    assert.equal(metricsResponse.status, 200);
    assert.deepEqual(await metricsResponse.json(), h.metrics);

    const trendsResponse = await fetch(
      `${h.base}/analytics/incidents/trends?${query}&bucket=day`,
    );
    assert.equal(trendsResponse.status, 200);
    assert.deepEqual(await trendsResponse.json(), h.trends);

    const summaryResponse = await fetch(
      `${h.base}/reports/system-summary?${query}`,
    );
    assert.equal(summaryResponse.status, 200);
    assert.deepEqual(await summaryResponse.json(), h.summary);

    assert.deepEqual(h.calls.map((call) => call.operation), [
      'metrics',
      'trends',
      'summary',
    ]);
    for (const call of h.calls) {
      assert.equal(call.input.from.toISOString(), from);
      assert.equal(call.input.to.toISOString(), to);
    }
    assert.equal(h.calls[1].input.bucket, 'day');
  } finally {
    await h.app.close();
  }
});

test('analytics endpoints use standard bad-request responses for invalid inputs', async () => {
  const h = await harness();
  try {
    const invalidDate = await fetch(
      `${h.base}/analytics/incidents?from=September-1&to=${encodeURIComponent(to)}`,
    );
    assert.equal(invalidDate.status, 400);
    assert.equal((await invalidDate.json()).statusCode, 400);

    const reversed = await fetch(
      `${h.base}/reports/system-summary?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`,
    );
    assert.equal(reversed.status, 400);

    const invalidBucket = await fetch(
      `${h.base}/analytics/incidents/trends?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=quarter`,
    );
    assert.equal(invalidBucket.status, 400);

    const missingRange = await fetch(
      `${h.base}/analytics/incidents/trends?bucket=day`,
    );
    assert.equal(missingRange.status, 400);
    assert.equal(h.calls.length, 0);
  } finally {
    await h.app.close();
  }
});

test('equal range boundaries are accepted as an empty valid interval', async () => {
  const h = await harness();
  try {
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(from)}&bucket=hour`;
    const response = await fetch(`${h.base}/analytics/incidents/trends?${query}`);
    assert.equal(response.status, 200);
    assert.equal(h.calls[0].input.from.getTime(), h.calls[0].input.to.getTime());
  } finally {
    await h.app.close();
  }
});
