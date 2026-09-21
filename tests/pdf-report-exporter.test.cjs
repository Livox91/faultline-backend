const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PdfReportExporter } = require('@faultline/reporting');

const baseReport = (overrides = {}) => ({
  reportId: 'report-1',
  generatedAt: '2026-09-21T11:00:00.000Z',
  incident: {
    id: 'INC-1032',
    title: 'Payment API memory exhaustion',
    severity: 'CRITICAL',
    status: 'RESOLVED',
    classification: 'MEMORY_EXHAUSTION',
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
    description: 'The payment API exhausted memory while processing requests.',
    suspectedCause: null,
    rootCause: 'An unbounded cache retained expired sessions.',
    ...overrides.summary,
  },
  anomalies: {
    total: 2,
    byClassification: { HIGH_MEMORY_UTILIZATION: 1, OOM_KILLED: 1 },
    bySource: { DETERMINISTIC: 2 },
    bySeverity: { HIGH: 1, CRITICAL: 1 },
    byStatus: { RESOLVED: 2 },
  },
  codeAnalysis: overrides.codeAnalysis ?? {
    totalFindings: 1,
    criticalFindings: 1,
    findings: [{ id: 'finding-1', severity: 'CRITICAL', title: 'Unbounded cache' }],
  },
  remediation: overrides.remediation ?? {
    suggested: [{ id: 'suggestion-1', title: 'Bound the cache' }],
    executed: [{ id: 'action-1', title: 'Restarted deployment', occurredAt: '2026-09-21T10:02:00.000Z' }],
  },
  health: overrides.health ?? {
    services: [{ service: 'payments', status: 'HEALTHY', observedAt: '2026-09-21T10:03:00.000Z' }],
  },
  timeline: overrides.timeline ?? [{
    id: 'timeline-1',
    timestamp: '2026-09-21T10:00:00.000Z',
    type: 'ANOMALY_OPENED',
    anomalyId: 'anomaly-1',
    classification: 'HIGH_MEMORY_UTILIZATION',
    source: 'DETERMINISTIC',
    severity: 'HIGH',
    summary: 'Memory utilization exceeded its threshold.',
  }],
});

test('PDF report exporter returns a non-empty recognizable PDF', async () => {
  const result = await new PdfReportExporter().export(baseReport());
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(result.filename, 'faultline-incident-INC-1032.pdf');
  assert.ok(Buffer.isBuffer(result.content));
  assert.ok(result.content.length > 1000);
  assert.equal(result.content.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('PDF report exporter handles missing optional sections and long text', async () => {
  const result = await new PdfReportExporter().export(baseReport({
    incident: {
      status: 'ACTIVE',
      acknowledgedAt: null,
      resolvedAt: null,
      affectedServices: [],
    },
    summary: { description: 'Long operational detail. '.repeat(500), rootCause: null },
    codeAnalysis: { totalFindings: 0, criticalFindings: 0, findings: [] },
    remediation: { suggested: [], executed: [] },
    health: { services: [] },
    timeline: [],
  }));
  assert.equal(result.contentType, 'application/pdf');
  assert.ok(result.content.length > 1000);
  assert.equal(result.content.subarray(0, 5).toString('ascii'), '%PDF-');
});

test('PDF incident export does not retain representative secret values', async () => {
  const secrets = ['pdf-bearer-secret', 'pdf-db-secret', 'pdf-access-secret', 'pdf-cookie-secret'];
  const result = await new PdfReportExporter().export(baseReport({
    summary: {
      description: 'Authorization: Bearer pdf-bearer-secret',
      rootCause: 'postgresql://admin:pdf-db-secret@db.example/faultline',
    },
    codeAnalysis: {
      totalFindings: 1,
      criticalFindings: 1,
      findings: [{ id: 'finding-secret', severity: 'CRITICAL', title: 'access_token=pdf-access-secret' }],
    },
    remediation: {
      suggested: [{ id: 'remediation-secret', title: 'Cookie: session=pdf-cookie-secret' }],
      executed: [],
    },
  }));
  const bytes = result.content.toString('latin1');
  for (const secret of secrets) assert.doesNotMatch(bytes, new RegExp(secret));
  assert.equal(result.content.subarray(0, 5).toString('ascii'), '%PDF-');
});
