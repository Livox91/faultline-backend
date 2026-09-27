require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const {
  InMemoryIncidentAcknowledgementRepository,
} = require('@faultline/notifications');
const {
  IncidentReportBuilder,
  CsvReportExporter,
  CSV_REPORT_EXPORTER,
  JsonReportExporter,
  JSON_REPORT_EXPORTER,
  PdfReportExporter,
  PDF_REPORT_EXPORTER,
} = require('@faultline/reporting');
const {
  INCIDENT_REPORT_BUILDER,
  IncidentReportController,
} = require('../apps/api/dist/incident-report.controller');

const detectedAt = '2026-09-21T10:00:00.000Z';
const acknowledgedAt = '2026-09-21T10:00:30.000Z';
const resolvedAt = '2026-09-21T10:02:00.000Z';
const generatedAt = '2026-09-21T11:00:00.000Z';

function resource(workload) {
  return {
    scope: 'deployment',
    clusterId: 'production-01',
    namespace: 'payments',
    workload,
    workloadKind: 'Deployment',
  };
}

function anomaly(id, classification, severity = 'HIGH') {
  return {
    anomalyId: id,
    dedupeKey: `dedupe-${id}`,
    ruleId: `rule.${classification.toLowerCase()}`,
    classification,
    source: 'DETERMINISTIC',
    severity,
    confidence: 0.9,
    clusterId: 'production-01',
    affectedResource: resource('payment-api'),
    timestamp: detectedAt,
    summary: classification,
    evidence: [],
    status: 'RESOLVED',
    firstSeen: detectedAt,
    lastSeen: resolvedAt,
  };
}

function incident() {
  const first = anomaly('anomaly-1', 'HIGH_MEMORY_UTILIZATION');
  const second = anomaly('anomaly-2', 'OOM_KILLED', 'CRITICAL');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    correlationKey: 'production-01:payments:payment-api',
    clusterId: 'production-01',
    namespace: 'payments',
    primaryResource: resource('payment-api'),
    affectedResources: [resource('payment-api'), resource('payment-worker')],
    classification: 'MEMORY_EXHAUSTION',
    title: 'Payment API memory exhaustion',
    summary: 'Payment requests failed while the API exhausted memory.',
    severity: 'CRITICAL',
    status: 'RESOLVED',
    logicalService: 'payments',
    confirmedRootCause: 'A cache retained expired payment sessions.',
    confidence: 0.98,
    firstSeen: detectedAt,
    lastSeen: resolvedAt,
    resolvedAt,
    anomalies: [first, second],
    evidence: [],
    timeline: [
      {
        id: 'timeline-2',
        timestamp: resolvedAt,
        type: 'ANOMALY_RESOLVED',
        anomalyId: second.anomalyId,
        classification: second.classification,
        source: second.source,
        severity: second.severity,
        summary: 'OOM condition resolved',
      },
      {
        id: 'timeline-1',
        timestamp: detectedAt,
        type: 'ANOMALY_OPENED',
        anomalyId: first.anomalyId,
        classification: first.classification,
        source: first.source,
        severity: first.severity,
        summary: 'Memory utilization opened',
      },
    ],
  };
}

async function setup(options = {}) {
  const incidents = new InMemoryIncidentRepository();
  const acknowledgements = new InMemoryIncidentAcknowledgementRepository();
  const value = incident();
  await incidents.createIncident(value);
  await acknowledgements.save({
    incidentId: value.id,
    acknowledgedBy: 'engineer-1',
    acknowledgedAt,
  });
  const builder = new IncidentReportBuilder(incidents, acknowledgements, {
    now: () => new Date(generatedAt),
    createReportId: () => 'report-1',
    ...options,
  });
  return { builder, incidents, incident: value };
}

test('complete incident generates a normalized technical report', async () => {
  const { builder, incident: value } = await setup({
    codeAnalysis: {
      async listForIncident() {
        return [
          { id: 'finding-1', severity: 'CRITICAL', title: 'Unbounded cache' },
          { id: 'finding-2', severity: 'WARNING', title: 'Missing eviction metric' },
        ];
      },
    },
    remediation: {
      async getForIncident() {
        return {
          suggested: [{ id: 'suggestion-1', title: 'Bound the session cache' }],
          executed: [{ id: 'action-1', title: 'Restarted affected deployment', occurredAt: resolvedAt }],
        };
      },
    },
    health: {
      async listForIncident() {
        return [{ service: 'payments', status: 'HEALTHY', observedAt: resolvedAt }];
      },
    },
  });

  const report = await builder.generateIncidentReport(value.id);
  assert.equal(report.reportId, 'report-1');
  assert.equal(report.generatedAt, generatedAt);
  assert.deepEqual(report.incident, {
    id: value.id,
    title: value.title,
    severity: 'CRITICAL',
    status: 'RESOLVED',
    classification: 'MEMORY_EXHAUSTION',
    clusterId: 'production-01',
    namespace: 'payments',
    detectedAt,
    acknowledgedAt,
    resolvedAt,
    durationMs: 120000,
    affectedServices: ['payment-api', 'payment-worker', 'payments'],
  });
  assert.deepEqual(report.summary, {
    description: value.summary,
    suspectedCause: null,
    rootCause: value.confirmedRootCause,
  });
  assert.deepEqual(report.anomalies, {
    total: 2,
    byClassification: { HIGH_MEMORY_UTILIZATION: 1, OOM_KILLED: 1 },
    bySource: { DETERMINISTIC: 2 },
    bySeverity: { HIGH: 1, CRITICAL: 1 },
    byStatus: { RESOLVED: 2 },
  });
  assert.equal(report.codeAnalysis.totalFindings, 2);
  assert.equal(report.codeAnalysis.criticalFindings, 1);
  assert.equal(report.remediation.suggested.length, 1);
  assert.equal(report.remediation.executed.length, 1);
  assert.equal(report.health.services.length, 1);
  assert.deepEqual(report.timeline.map((entry) => entry.id), ['timeline-1', 'timeline-2']);
});

test('missing code analysis does not break report generation', async () => {
  const { builder, incident: value } = await setup({
    codeAnalysis: { async listForIncident() { throw new Error('unavailable'); } },
  });
  const report = await builder.generateIncidentReport(value.id);
  assert.deepEqual(report.codeAnalysis, {
    totalFindings: 0,
    criticalFindings: 0,
    findings: [],
  });
});

test('missing remediation does not break report generation', async () => {
  const { builder, incident: value } = await setup({
    remediation: { async getForIncident() { return undefined; } },
  });
  const report = await builder.generateIncidentReport(value.id);
  assert.deepEqual(report.remediation, { suggested: [], executed: [] });
});

test('missing health data does not break report generation', async () => {
  const { builder, incident: value } = await setup({
    health: { async listForIncident() { throw new Error('unavailable'); } },
  });
  const report = await builder.generateIncidentReport(value.id);
  assert.deepEqual(report.health, { services: [] });
});

test('technical report builder redacts incident, analysis, remediation, health, and timeline text', async () => {
  const { builder, incidents, incident: value } = await setup({
    codeAnalysis: { async listForIncident() { return [{ id: 'finding', severity: 'CRITICAL', title: 'API_KEY=analysis-secret' }]; } },
    remediation: { async getForIncident() { return { suggested: [{ id: 'suggestion', title: 'access_token=remediation-secret' }], executed: [] }; } },
    health: { async listForIncident() { return [{ service: 'payments', status: 'DEGRADED', summary: 'Cookie: health-cookie-secret' }]; } },
  });
  await incidents.updateIncident({
    ...value,
    summary: 'Authorization: Bearer incident-bearer-secret for customer@example.com',
    confirmedRootCause: 'postgresql://admin:incident-db-secret@db.example/faultline',
    timeline: [{ ...value.timeline[0], summary: 'refresh_token=timeline-secret' }],
  });
  const report = await builder.generateIncidentReport(value.id);
  const serialized = JSON.stringify(report);
  for (const secret of [
    'incident-bearer-secret', 'customer@example.com', 'incident-db-secret',
    'analysis-secret', 'remediation-secret', 'health-cookie-secret', 'timeline-secret',
  ]) assert.doesNotMatch(serialized, new RegExp(secret.replaceAll('.', '\\.')));
  assert.match(serialized, /REDACTED/);
});

test('report endpoint returns a report and validates incident IDs', async () => {
  const { builder, incident: value } = await setup();
  class ReportApiModule {}
  Module({
    controllers: [IncidentReportController],
    providers: [
      { provide: INCIDENT_REPORT_BUILDER, useValue: builder },
      { provide: JSON_REPORT_EXPORTER, useClass: JsonReportExporter },
      { provide: CSV_REPORT_EXPORTER, useClass: CsvReportExporter },
      { provide: PDF_REPORT_EXPORTER, useClass: PdfReportExporter },
    ],
  })(ReportApiModule);
  const app = await NestFactory.create(ReportApiModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const response = await fetch(`${base}/reports/incidents/${value.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).incident.id, value.id);

    const invalid = await fetch(`${base}/reports/incidents/not-a-uuid`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).statusCode, 400);

    const exported = await fetch(
      `${base}/reports/incidents/${value.id}/export?format=json`,
    );
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /^application\/json/);
    assert.match(
      exported.headers.get('content-disposition'),
      /attachment; filename="faultline-incident-11111111-1111-4111-8111-111111111111\.json"/,
    );
    const exportedReport = await exported.json();
    assert.equal(exportedReport.incident.id, value.id);
    assert.deepEqual(exportedReport.remediation, { suggested: [], executed: [] });

    const invalidExportId = await fetch(
      `${base}/reports/incidents/not-a-uuid/export?format=json`,
    );
    assert.equal(invalidExportId.status, 400);

    const csv = await fetch(
      `${base}/reports/incidents/${value.id}/export?format=csv`,
    );
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv;\s*charset=utf-8/i);
    assert.match(
      csv.headers.get('content-disposition'),
      /attachment; filename="faultline-incident-11111111-1111-4111-8111-111111111111\.csv"/,
    );
    assert.match(await csv.text(), new RegExp(`\\r\\n${value.id},`));

    const pdf = await fetch(
      `${base}/reports/incidents/${value.id}/export?format=pdf`,
    );
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /^application\/pdf/);
    assert.match(
      pdf.headers.get('content-disposition'),
      /attachment; filename="faultline-incident-11111111-1111-4111-8111-111111111111\.pdf"/,
    );
    assert.equal(
      Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('ascii'),
      '%PDF-',
    );
  } finally {
    await app.close();
  }
});

test('nonexistent incident uses the API standard not-found response', async () => {
  const incidents = new InMemoryIncidentRepository();
  const builder = new IncidentReportBuilder(incidents);
  class MissingReportApiModule {}
  Module({
    controllers: [IncidentReportController],
    providers: [
      { provide: INCIDENT_REPORT_BUILDER, useValue: builder },
      { provide: JSON_REPORT_EXPORTER, useClass: JsonReportExporter },
      { provide: CSV_REPORT_EXPORTER, useClass: CsvReportExporter },
      { provide: PDF_REPORT_EXPORTER, useClass: PdfReportExporter },
    ],
  })(MissingReportApiModule);
  const app = await NestFactory.create(MissingReportApiModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(
      `${await app.getUrl()}/reports/incidents/22222222-2222-4222-8222-222222222222`,
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).message, 'Incident not found');
    const exported = await fetch(
      `${await app.getUrl()}/reports/incidents/22222222-2222-4222-8222-222222222222/export?format=json`,
    );
    assert.equal(exported.status, 404);
    assert.equal((await exported.json()).message, 'Incident not found');
  } finally {
    await app.close();
  }
});
