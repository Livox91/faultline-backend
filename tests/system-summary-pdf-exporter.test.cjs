const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SystemSummaryPdfExporter } = require('@faultline/reporting');
const { PDFParse } = require('pdf-parse');

test('system summary PDF exporter creates a named PDF attachment', async () => {
  const result = await new SystemSummaryPdfExporter().export({
    generatedAt: '2026-10-04T12:00:00.000Z',
    period: { from: '2026-09-27T12:00:00.000Z', to: '2026-10-04T12:00:00.000Z' },
    health: { available: true, overallStatus: 'ok', healthyServices: 3, degradedServices: 0, unhealthyServices: 0 },
    incidents: { total: 4, critical: 1, resolved: 3, unresolved: 1 },
    performance: { mttrMs: 120000, mttaMs: null, resolutionRate: 0.75 },
    incidentsBySeverity: { CRITICAL: 1, HIGH: 2, WARNING: 1 },
    topAffectedServices: [{ service: 'checkout', incidentCount: 2 }],
    commonIncidentCategories: [{ classification: 'APPLICATION_DEPENDENCY_FAILURE', incidentCount: 2 }],
    trends: [{ timestamp: '2026-10-03T00:00:00.000Z', total: 4, critical: 1, resolved: 3 }],
  });
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(result.filename, 'faultline-system-summary-2026-10-04.pdf');
  assert.ok(Buffer.isBuffer(result.content));
  assert.equal(result.content.subarray(0, 4).toString(), '%PDF');
  const parser = new PDFParse({ data: result.content });
  try {
    const info = await parser.getInfo();
    const extracted = await parser.getText();
    assert.equal(info.total, 2, 'the compact report should contain exactly two populated pages');
    for (const heading of [
      'Executive metrics', 'System health', 'Incidents by severity',
      'Top affected services', 'Common incident categories', 'Daily incident trend',
    ]) assert.match(extracted.text, new RegExp(heading, 'i'));
    assert.doesNotMatch(extracted.text, /-- 3 of 3 --/);
  } finally {
    await parser.destroy();
  }
});

test('system summary PDF keeps a populated dashboard report to two pages without trailing blanks', async () => {
  const names = ['booknest-frontend', 'booknest-backend', 'faultline-collector-events', 'faultline-collector-logs', 'kube-proxy', 'local-path-provisioner', 'kindnet', 'coredns'];
  const categories = ['RESOURCE_SATURATION', 'APPLICATION_DEPENDENCY_FAILURE', 'DEPLOYMENT_DEGRADATION', 'WORKLOAD_CRASHING'];
  const result = await new SystemSummaryPdfExporter().export({
    generatedAt: '2026-10-04T12:00:00.000Z',
    period: { from: '2026-09-27T12:00:00.000Z', to: '2026-10-04T12:00:00.000Z' },
    health: { available: true, overallStatus: 'ok', healthyServices: 1, degradedServices: 0, unhealthyServices: 0 },
    incidents: { total: 23, critical: 4, resolved: 11, unresolved: 12 },
    performance: { mttrMs: 212784000, mttaMs: null, resolutionRate: 11 / 23 },
    incidentsBySeverity: { CRITICAL: 4, HIGH: 13, WARNING: 6 },
    topAffectedServices: names.map((service, index) => ({ service, incidentCount: Math.max(1, 5 - Math.floor(index / 2)) })),
    commonIncidentCategories: categories.map((classification, index) => ({ classification, incidentCount: 16 - index * 4 })),
    trends: Array.from({ length: 7 }, (_, index) => ({
      timestamp: `2026-10-0${index + 1}T00:00:00.000Z`, total: index + 1,
      critical: index % 2, resolved: Math.max(0, index - 1),
    })),
  });
  const parser = new PDFParse({ data: result.content });
  try {
    const info = await parser.getInfo();
    const extracted = await parser.getText();
    assert.equal(info.total, 2);
    assert.match(extracted.text, /booknest-frontend/);
    assert.match(extracted.text, /WORKLOAD CRASHING/);
    assert.match(extracted.text, /2026-10-07/);
    assert.match(extracted.text, /Page 2 of 2/);
  } finally {
    await parser.destroy();
  }
});
