const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CsvReportExporter } = require('@faultline/reporting');

const report = (overrides = {}) => ({
  reportId: 'report-1',
  generatedAt: '2026-09-21T11:00:00.000Z',
  incident: {
    id: 'incident-1',
    title: 'Payment failure',
    severity: 'CRITICAL',
    status: 'RESOLVED',
    classification: 'APPLICATION_DEPENDENCY_FAILURE',
    clusterId: 'production-01',
    namespace: 'payments',
    detectedAt: '2026-09-21T10:00:00.000Z',
    acknowledgedAt: '2026-09-21T10:00:30.000Z',
    resolvedAt: '2026-09-21T10:02:00.000Z',
    durationMs: 120000,
    affectedServices: ['payments', 'database'],
    ...overrides.incident,
  },
  summary: {
    description: 'Payment dependency failed',
    suspectedCause: null,
    rootCause: null,
    ...overrides.summary,
  },
  anomalies: { total: 0, byClassification: {}, bySource: {}, bySeverity: {}, byStatus: {} },
  codeAnalysis: { totalFindings: 0, criticalFindings: 0, findings: [] },
  remediation: { suggested: [], executed: [] },
  health: { services: [] },
  resourceSnapshots: overrides.resourceSnapshots ?? [],
  timeline: [],
});

test('CSV report exporter writes stable headers and a normal incident row', async () => {
  const result = await new CsvReportExporter().export(report());
  const [headers, row] = result.content.split('\r\n');
  assert.equal(
    headers,
    'incidentId,title,description,severity,status,affectedServices,detectedAt,acknowledgedAt,resolvedAt,resolutionTimeMs,snapshotObservedAt,cpuUsageCores,cpuUtilizationPercent,memoryUsageBytes,memoryUtilizationPercent',
  );
  assert.equal(
    row,
    'incident-1,Payment failure,Payment dependency failed,CRITICAL,RESOLVED,payments;database,2026-09-21T10:00:00.000Z,2026-09-21T10:00:30.000Z,2026-09-21T10:02:00.000Z,120000,,,,,',
  );
});

test('CSV report exporter flattens service arrays consistently', async () => {
  const result = await new CsvReportExporter().export(report({
    incident: { affectedServices: ['api', 'database', 'queue'] },
  }));
  assert.match(result.content, /,api;database;queue,/);
  assert.doesNotMatch(result.content, /\[object Object\]/);
});

test('CSV report exporter escapes commas, quotes, and newlines', async () => {
  const result = await new CsvReportExporter().export(report({
    incident: { title: 'Payment, "retry" failure' },
    summary: { description: 'First line\nSecond, "quoted" line' },
  }));
  assert.match(result.content, /"Payment, ""retry"" failure"/);
  assert.match(result.content, /"First line\nSecond, ""quoted"" line"/);
});

test('CSV report exporter emits empty fields for null optional timestamps', async () => {
  const result = await new CsvReportExporter().export(report({
    incident: {
      status: 'ACTIVE',
      acknowledgedAt: null,
      resolvedAt: null,
      durationMs: 60000,
    },
  }));
  const row = result.content.split('\r\n')[1];
  const values = row.split(',');
  assert.equal(values[7], '');
  assert.equal(values[8], '');
  assert.equal(values[9], '');
});

test('CSV report exporter includes the incident-time CPU and memory snapshot', async () => {
  const result = await new CsvReportExporter().export(report({
    resourceSnapshots: [{
      observedAt: '2026-09-21T10:00:00.000Z',
      cpuUsageCores: 0.42,
      cpuUtilizationPercent: 42,
      memoryUsageBytes: 458227712,
      memoryUtilizationPercent: 85.34,
    }],
  }));
  assert.match(result.content, /2026-09-21T10:00:00\.000Z,0\.42,42,458227712,85\.34$/);
});

test('CSV report exporter uses a UTF-8 CSV content type', async () => {
  const result = await new CsvReportExporter().export(report());
  assert.equal(result.contentType, 'text/csv; charset=utf-8');
});

test('CSV incident export redacts secrets embedded in title and description', async () => {
  const result = await new CsvReportExporter().export(report({
    incident: { title: 'Failure for customer@example.com API_KEY=csv-secret-key' },
    summary: { description: 'Bearer csv-bearer-secret database_url=postgresql://admin:csv-db-secret@db/faultline' },
  }));
  for (const secret of ['customer@example.com', 'csv-secret-key', 'csv-bearer-secret', 'csv-db-secret'])
    assert.doesNotMatch(result.content, new RegExp(secret.replaceAll('.', '\\.')));
  assert.match(result.content, /REDACTED/);
});
