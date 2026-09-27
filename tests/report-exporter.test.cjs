const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  JsonReportExporter,
  REDACTED_REPORT_VALUE,
} = require('@faultline/reporting');

test('JSON report exporter produces valid JSON with the correct content type', async () => {
  const exporter = new JsonReportExporter();
  const result = await exporter.export({ reportId: 'report-1', total: 2 });
  assert.equal(result.contentType, 'application/json');
  assert.deepEqual(JSON.parse(result.content), { reportId: 'report-1', total: 2 });
});

test('JSON report exporter preserves nested normalized report data', async () => {
  const exporter = new JsonReportExporter();
  const report = {
    incident: { id: 'incident-1', services: ['payments', 'database'] },
    anomalies: { total: 2, bySeverity: { CRITICAL: 1, WARNING: 1 } },
    timeline: [{ timestamp: '2026-09-21T10:00:00.000Z', type: 'ANOMALY_OPENED' }],
  };
  assert.deepEqual(JSON.parse((await exporter.export(report)).content), report);
});

test('JSON report exporter handles optional values and normalizes dates', async () => {
  const exporter = new JsonReportExporter();
  const result = JSON.parse((await exporter.export({
    generatedAt: new Date('2026-09-21T10:00:00.000Z'),
    acknowledgedAt: null,
    omitted: undefined,
    findings: [],
  })).content);
  assert.deepEqual(result, {
    generatedAt: '2026-09-21T10:00:00.000Z',
    acknowledgedAt: null,
    findings: [],
  });
});

test('JSON report exporter redacts credential-shaped nested fields', async () => {
  const exporter = new JsonReportExporter();
  const result = JSON.parse((await exporter.export({
    summary: 'Operational summary remains visible',
    details: {
      apiKey: 'do-not-export',
      developmentAgentToken: 'do-not-export',
      nested: { database_password: 'do-not-export' },
    },
  })).content);
  assert.equal(result.summary, 'Operational summary remains visible');
  assert.equal(result.details.apiKey, REDACTED_REPORT_VALUE);
  assert.equal(result.details.developmentAgentToken, REDACTED_REPORT_VALUE);
  assert.equal(result.details.nested.database_password, REDACTED_REPORT_VALUE);
  assert.doesNotMatch(JSON.stringify(result), /do-not-export/);
});

test('JSON incident export redacts secrets embedded in normalized report text', async () => {
  const exporter = new JsonReportExporter();
  const secrets = [
    'bearer-secret-123',
    'db-password-456',
    'access-secret-789',
    'refresh-secret-012',
    'customer@example.com',
    '+15551234567',
    'basic-credentials-345',
    'secondary-cookie-678',
    'legacy-password-901',
  ];
  const report = {
    summary: { description: 'Authorization: Bearer bearer-secret-123 customer customer@example.com\nProxy-Authorization: Basic basic-credentials-345' },
    codeAnalysis: { findings: [{ description: 'database_url=postgresql://admin:db-password-456@db.example/faultline' }] },
    remediation: { suggested: [{ description: 'access_token=access-secret-789 refresh_token=refresh-secret-012' }] },
    timeline: [{ summary: 'Contact +15551234567 Cookie: session=customer-cookie; secondary=secondary-cookie-678\nconnection_string=Server=db;Database=faultline;Password=legacy-password-901' }],
  };
  const content = (await exporter.export(report)).content;
  for (const secret of [...secrets, 'customer-cookie'])
    assert.doesNotMatch(content, new RegExp(secret.replaceAll('+', '\\+')));
  assert.match(content, /REDACTED/);
});
