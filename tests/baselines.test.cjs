require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BaselineEngine,
  CachedBaselineProvider,
  InMemoryBaselineRepository,
  baselineMetricDefinitions,
  counterRate,
  findBaselineMetric,
  linearTrend,
  mergeRanges,
  percentDeviation,
  percentile,
  summarize,
  zScore,
} = require('@faultline/baselines');
const {
  InMemoryStatisticalDetector,
} = require('../apps/processor/dist/statistical/statistical-detector');
const {
  contributionsFor,
  currentObservation,
} = require('../apps/processor/dist/statistical/signals');
const {
  InMemoryResourceState,
} = require('../apps/processor/dist/resource-state/in-memory-resource-state');
const {
  InMemoryRuleEngine,
  createDefaultRules,
} = require('../apps/processor/dist/rules');
const {
  IncidentCorrelationEngine,
} = require('../apps/processor/dist/correlation');
const {
  TelemetryConsumer,
} = require('../apps/processor/dist/telemetry.consumer');
const {
  BaselinesController,
} = require('../apps/api/dist/baselines.controller');
const {
  ConfiguredTelemetryScopeResolver,
} = require('../apps/api/dist/telemetry-scope');
const { InMemoryIncidentRepository } = require('@faultline/incidents');
const { InMemoryQueue } = require('@faultline/queue');
const { defaultQueryLimits } = require('@faultline/telemetry');

const silentLogger = { log() {}, warn() {}, error() {}, debug() {}, verbose() {} };
const MiB = 1024 * 1024;
const iso = (ms) => new Date(ms).toISOString();

const detectionConfig = (overrides = {}) => ({
  enabled: true,
  evaluationWindowMs: 900_000,
  minimumCurrentSamples: 3,
  zScoreThreshold: 3,
  zScoreResolveThreshold: 2,
  percentileRatioThreshold: 2,
  percentileRatioResolveThreshold: 1.5,
  minimumConsecutiveWindows: 3,
  resolveConsecutiveWindows: 3,
  cooldownMs: 600_000,
  deviationRelativeFloor: 0.05,
  growthMinimumSamples: 6,
  growthMinimumPercent: 25,
  growthMinimumRSquared: 0.7,
  growthMinimumMonotonicFraction: 0.7,
  ...overrides,
});

const workload = {
  clusterId: 'production-eu',
  namespace: 'payments',
  workload: 'payment-api',
};

function baselineOf({
  metricName,
  mean,
  standardDeviation,
  p50 = mean,
  p95 = mean + standardDeviation * 2,
  p99 = mean + standardDeviation * 3,
  min = Math.max(0, mean - standardDeviation * 3),
  max = mean + standardDeviation * 4,
  sampleCount = 1440,
  status = 'READY',
  window = '24h',
  resourceType = 'container',
  unit,
}) {
  return {
    ...workload,
    resourceType,
    metricName,
    window,
    season: { kind: 'all' },
    status,
    ...(status === 'READY'
      ? {
          statistics: {
            sampleCount,
            mean,
            min,
            max,
            standardDeviation,
            p50,
            p95,
            p99,
          },
        }
      : {}),
    sampleCount,
    ...(unit ? { unit } : {}),
    windowStart: iso(Date.now() - 86_400_000),
    windowEnd: iso(Date.now()),
    excludedRanges: 0,
    updatedAt: iso(Date.now()),
  };
}

async function detectorWith(baselines, overrides = {}) {
  const repository = new InMemoryBaselineRepository();
  await repository.save(baselines);
  const provider = new CachedBaselineProvider(repository, 60_000);
  return {
    repository,
    provider,
    detector: new InMemoryStatisticalDetector(
      provider,
      detectionConfig(overrides),
    ),
  };
}

const identity = {
  ...workload,
  pod: 'payment-api-7d9f',
  container: 'api',
  node: 'node-a',
  service: 'payment-api',
  attributes: { 'k8s.pod.uid': 'payment-uid' },
  raw: null,
};

let sequence = 0;
const metricEvent = (name, value, timestampMs, extra = {}) => ({
  ...identity,
  ...extra,
  kind: 'metric',
  id: `metric-${name}-${sequence++}`,
  timestamp: iso(timestampMs),
  ingestedAt: iso(timestampMs),
  name,
  value,
  metricType: 'gauge',
  attributes: { ...identity.attributes, ...(extra.attributes ?? {}) },
});

const logEvent = (level, timestampMs) => ({
  ...identity,
  kind: 'log',
  id: `log-${sequence++}`,
  timestamp: iso(timestampMs),
  ingestedAt: iso(timestampMs),
  level,
  message: `${level} message`,
  stream: level === 'error' ? 'stderr' : 'stdout',
  attributes: identity.attributes,
});

/** Feeds a series and collects every anomaly the detector emitted. */
async function feed(detector, events) {
  const emitted = [];
  for (const event of events) emitted.push(...(await detector.detect(event)));
  return emitted;
}

const series = (count, valueAt, startMs, stepMs = 15_000) =>
  Array.from({ length: count }, (_unused, index) => ({
    value: valueAt(index),
    timestamp: startMs + index * stepMs,
  }));

test('statistics primitives are explainable and reset-tolerant', () => {
  assert.equal(zScore(510, 420, 25), 3.6);
  // Without a floor a flat metric turns ordinary jitter into an enormous score.
  assert.equal(zScore(100, 100, 0), undefined);
  assert.equal(Math.round(percentDeviation(530, 440) * 10) / 10, 20.5);
  assert.equal(percentDeviation(10, 0), undefined);

  const stats = summarize([10, 20, 30, 40, 50]);
  assert.equal(stats.mean, 30);
  assert.equal(stats.p50, 30);
  assert.equal(stats.sampleCount, 5);
  assert.equal(Math.round(stats.standardDeviation), 14);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);

  // A counter that restarts contributes the work it did, never a negative rate.
  assert.equal(counterRate(100, 400, 60_000, 1), 5);
  assert.equal(counterRate(900, 200, 60_000, 1), 200 / 60);

  const rising = linearTrend(
    [310, 330, 355, 390, 430, 475].map((value, index) => ({
      timestamp: index * 300_000,
      value,
    })),
  );
  assert.ok(rising.slopePerMs > 0);
  assert.ok(rising.rSquared > 0.95);
  assert.equal(rising.monotonicFraction, 1);
  assert.equal(Math.round(rising.changePercent), 53);

  // A sawtooth ends higher than it began but is not a trend.
  const noisy = linearTrend(
    [300, 500, 310, 520, 300, 510].map((value, index) => ({
      timestamp: index * 300_000,
      value,
    })),
  );
  assert.ok(noisy.rSquared < 0.7);
  assert.ok(noisy.monotonicFraction < 0.7);
  assert.equal(linearTrend([{ timestamp: 1, value: 1 }]), undefined);
});

test('insufficient history reports BASELINE_NOT_READY and raises nothing', async () => {
  const history = {
    listBaselineTargets: async () => [workload],
    summarizeMetric: async () => ({
      sampleCount: 4,
      statistics: {
        sampleCount: 4,
        mean: 400 * MiB,
        min: 390 * MiB,
        max: 410 * MiB,
        standardDeviation: 8 * MiB,
        p50: 400 * MiB,
        p95: 408 * MiB,
        p99: 410 * MiB,
      },
    }),
    findDisruptionWindows: async () => [],
  };
  const repository = new InMemoryBaselineRepository();
  const engine = new BaselineEngine(history, repository, {
    windows: { default: '24h', fast: '1h' },
    minimumSamples: 60,
    bucketMs: 60_000,
    maxTargets: 10,
    maxSamplesPerSummary: 1000,
    excludeDisruptedPeriods: false,
    disruptionPaddingMs: 0,
    disruptionReasons: [],
  });
  const result = await engine.refresh();
  assert.equal(result.ready, 0);
  assert.equal(result.notReady, baselineMetricDefinitions.length);

  const stored = await repository.list({ metricName: 'k8s.container.memory.usage' });
  assert.equal(stored[0].status, 'BASELINE_NOT_READY');
  // Sample count is still recorded so an operator can see how close it is.
  assert.equal(stored[0].sampleCount, 4);
  assert.equal(stored[0].statistics, undefined);

  // A newly deployed workload behaving normally must not be called anomalous.
  const { detector } = await detectorWith(stored);
  const base = Date.now() - 600_000;
  const emitted = await feed(
    detector,
    series(8, () => 900 * MiB, base).map((sample) =>
      metricEvent('k8s.container.memory.usage', sample.value, sample.timestamp),
    ),
  );
  assert.deepEqual(emitted, []);
});

test('behaviour within the baseline raises nothing', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.memory.usage',
      mean: 400 * MiB,
      standardDeviation: 25 * MiB,
      unit: 'By',
    }),
    baselineOf({
      metricName: 'k8s.container.cpu.usage',
      mean: 0.4,
      standardDeviation: 0.05,
      unit: 'cores',
    }),
  ]);
  const base = Date.now() - 600_000;
  const emitted = await feed(detector, [
    ...series(8, (index) => (395 + index) * MiB, base).map((sample) =>
      metricEvent('k8s.container.memory.usage', sample.value, sample.timestamp),
    ),
    ...series(8, (index) => 0.4 + index * 0.002, base).map((sample) =>
      metricEvent('k8s.container.cpu.usage', sample.value, sample.timestamp),
    ),
  ]);
  assert.deepEqual(emitted, []);
});

test('a CPU deviation opens a scored, explainable anomaly', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.cpu.usage',
      mean: 0.2,
      standardDeviation: 0.02,
      unit: 'cores',
    }),
  ]);
  const base = Date.now() - 600_000;
  const emitted = await feed(
    detector,
    series(6, () => 0.5, base).map((sample) =>
      metricEvent('k8s.container.cpu.usage', sample.value, sample.timestamp),
    ),
  );
  const opened = emitted.find((anomaly) => anomaly.status === 'OPEN');
  assert.ok(opened, 'an anomaly opened');
  assert.equal(opened.classification, 'CPU_USAGE_ANOMALY');
  assert.equal(opened.source, 'STATISTICAL');
  assert.equal(opened.anomalyScore, 15);
  // Score and confidence are different quantities and must not be conflated.
  assert.notEqual(opened.anomalyScore, opened.confidence);
  assert.ok(opened.confidence > 0.5 && opened.confidence <= 0.95);
  assert.equal(opened.baseline.metricName, 'k8s.container.cpu.usage');
  assert.equal(opened.baseline.mean, 0.2);
  const baselineEvidence = opened.evidence.find(
    (entry) => entry.type === 'baseline',
  );
  assert.ok(baselineEvidence, 'baseline evidence is preserved');
  assert.equal(baselineEvidence.attributes.scoreKind, 'standard-deviations');
  assert.ok(
    opened.evidence.some(
      (entry) =>
        entry.type === 'calculation' &&
        typeof entry.attributes.deviationPercent === 'number',
    ),
  );
  // A brief single-replica spike is never CRITICAL.
  assert.equal(opened.severity, 'WARNING');
});

test('a memory deviation is reported below the deterministic hard limit', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'faultline.container.memory.utilization',
      mean: 35,
      standardDeviation: 4,
      unit: '%',
    }),
  ]);
  const base = Date.now() - 600_000;
  // 70% is far outside this workload's normal 35%, yet nowhere near a 95% limit rule.
  const emitted = [];
  for (const sample of series(6, () => 700 * MiB, base))
    emitted.push(
      ...(await detector.detect(
        metricEvent('k8s.container.memory.usage', sample.value, sample.timestamp),
        {
          scope: 'container',
          ...identity,
          memoryUtilizationPercent: 70,
          updatedAt: iso(sample.timestamp),
          fieldTimestamps: {},
        },
      )),
    );
  const opened = emitted.find((anomaly) => anomaly.status === 'OPEN');
  assert.ok(opened);
  assert.equal(opened.classification, 'MEMORY_USAGE_ANOMALY');
  assert.equal(opened.baseline.metricName, 'faultline.container.memory.utilization');
  assert.equal(opened.anomalyScore, 8.75);
  assert.match(opened.summary, /70(\.0)?%/);
});

test('sustained memory growth is reported as growth, not as a diagnosis', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.memory.usage',
      mean: 400 * MiB,
      standardDeviation: 60 * MiB,
      unit: 'By',
    }),
  ]);
  const base = Date.now() - 1_800_000;
  const climb = [310, 330, 355, 390, 430, 475, 520, 570, 625, 680];
  const emitted = await feed(
    detector,
    climb.map((value, index) =>
      metricEvent(
        'k8s.container.memory.usage',
        value * MiB,
        base + index * 60_000,
      ),
    ),
  );
  const growth = emitted.find(
    (anomaly) => anomaly.classification === 'MEMORY_GROWTH_ANOMALY',
  );
  assert.ok(growth, 'sustained growth was detected');
  assert.equal(growth.source, 'STATISTICAL');
  // The classification deliberately does not claim a leak: the cause is unknown.
  assert.match(growth.summary, /rose .*% over \d+ minutes/);
  const calculation = growth.evidence.find(
    (entry) => entry.type === 'calculation',
  );
  assert.ok(calculation.attributes.changePercent >= 25);
  assert.ok(calculation.attributes.rSquared >= 0.7);
  assert.ok(calculation.attributes.perHour > 0);

  // A noisy series that merely ends higher is not sustained growth.
  const { detector: noisyDetector } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.memory.usage',
      mean: 400 * MiB,
      standardDeviation: 200 * MiB,
      unit: 'By',
    }),
  ]);
  const sawtooth = [300, 520, 305, 530, 300, 540, 310, 545, 300, 550];
  const noisy = await feed(
    noisyDetector,
    sawtooth.map((value, index) =>
      metricEvent(
        'k8s.container.memory.usage',
        value * MiB,
        base + index * 60_000,
      ),
    ),
  );
  assert.equal(
    noisy.some((anomaly) => anomaly.classification === 'MEMORY_GROWTH_ANOMALY'),
    false,
  );
});

test('an error-rate spike is measured as a share of logs, not a raw count', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'faultline.workload.log_error_rate',
      mean: 0.8,
      standardDeviation: 0.4,
      unit: '%',
      resourceType: 'workload',
      window: '1h',
    }),
  ]);
  const base = Date.now() - 600_000;
  const levels = ['info', 'info', 'error', 'error', 'error', 'error', 'error'];
  const emitted = await feed(
    detector,
    levels.map((level, index) => logEvent(level, base + index * 10_000)),
  );
  const opened = emitted.find((anomaly) => anomaly.status === 'OPEN');
  assert.ok(opened);
  assert.equal(opened.classification, 'ERROR_RATE_ANOMALY');
  // Errors are attributed to the pod, not to a single container inside it.
  assert.equal(opened.affectedResource.scope, 'pod');
  assert.equal(opened.affectedResource.container, undefined);

  // Logging more overall, at the same error share, is not an anomaly.
  const { detector: chattyDetector } = await detectorWith([
    baselineOf({
      metricName: 'faultline.workload.log_error_rate',
      mean: 0.8,
      standardDeviation: 0.4,
      unit: '%',
      resourceType: 'workload',
      window: '1h',
    }),
  ]);
  const chatty = await feed(
    chattyDetector,
    Array.from({ length: 250 }, (_unused, index) =>
      logEvent(index % 125 === 60 ? 'error' : 'info', base + index * 1000),
    ),
  );
  assert.deepEqual(chatty, []);
});

test('a network counter spike becomes a rate anomaly', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'faultline.pod.network.receive_rate',
      mean: 20_000,
      standardDeviation: 4_000,
      unit: 'By/s',
      resourceType: 'pod',
      window: '1h',
    }),
  ]);
  const base = Date.now() - 600_000;
  // A cumulative counter climbing by 5 MB every 10 seconds: ~500 KB/s.
  const emitted = await feed(
    detector,
    series(6, (index) => 1_000_000 + index * 5_000_000, base, 10_000).map(
      (sample) =>
        metricEvent(
          'k8s.pod.network.io',
          sample.value,
          sample.timestamp,
          { attributes: { direction: 'receive' } },
        ),
    ),
  );
  const opened = emitted.find((anomaly) => anomaly.status === 'OPEN');
  assert.ok(opened);
  assert.equal(opened.classification, 'NETWORK_RX_ANOMALY');
  assert.ok(opened.anomalyScore > 100);

  // A counter reset must not register as a huge negative rate.
  const observation = currentObservation(
    [
      { timestamp: 0, value: 900 },
      { timestamp: 10_000, value: 1000 },
      { timestamp: 20_000, value: 50 },
    ],
    findBaselineMetric('faultline.pod.network.receive_rate'),
  );
  assert.ok(observation.value > 0);
});

test('latency is compared by percentile and only when the metric exists', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'http.server.duration',
      mean: 140,
      standardDeviation: 30,
      p50: 130,
      p95: 180,
      p99: 240,
      unit: 'ms',
      resourceType: 'workload',
      window: '1h',
    }),
  ]);
  const base = Date.now() - 600_000;
  const emitted = await feed(
    detector,
    series(6, () => 730, base).map((sample) =>
      metricEvent('http.server.duration', sample.value, sample.timestamp),
    ),
  );
  const opened = emitted.find((anomaly) => anomaly.status === 'OPEN');
  assert.ok(opened);
  assert.equal(opened.classification, 'LATENCY_ANOMALY');
  // A percentile multiple, not a z-score: latency distributions are long-tailed.
  assert.equal(opened.anomalyScore, Math.round((730 / 180) * 100) / 100);
  assert.equal(
    opened.evidence.find((entry) => entry.type === 'baseline').attributes
      .scoreKind,
    'percentile-multiple',
  );
  assert.match(opened.summary, /730 ms against a normal 180 ms/);

  // With no latency baseline nothing is raised, and nothing is inferred from logs.
  const { detector: bare } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.memory.usage',
      mean: 400 * MiB,
      standardDeviation: 25 * MiB,
    }),
  ]);
  const silent = await feed(bare, [
    ...series(6, () => 730, base).map((sample) =>
      metricEvent('http.server.duration', sample.value, sample.timestamp),
    ),
    ...series(6, () => 5000, base).map((sample) =>
      metricEvent('request.duration', sample.value, sample.timestamp),
    ),
    ...Array.from({ length: 8 }, (_unused, index) =>
      logEvent('error', base + index * 1000),
    ),
  ]);
  assert.deepEqual(silent, []);
});

test('anomalies deduplicate, hold through hysteresis, resolve, and honour cooldown', async () => {
  const { detector } = await detectorWith(
    [
      baselineOf({
        metricName: 'k8s.container.memory.usage',
        mean: 400 * MiB,
        standardDeviation: 25 * MiB,
        unit: 'By',
      }),
    ],
    { evaluationWindowMs: 45_000, growthMinimumSamples: 1000 },
  );
  const base = Date.now() - 3_600_000;
  const at = (offsetSeconds) => base + offsetSeconds * 1000;
  const send = async (offsetSeconds, mib) =>
    detector.detect(
      metricEvent('k8s.container.memory.usage', mib * MiB, at(offsetSeconds)),
    );

  const opening = [];
  for (const offset of [0, 15, 30, 45, 60])
    opening.push(...(await send(offset, 900)));
  const opened = opening.filter((anomaly) => anomaly.status === 'OPEN');
  assert.equal(opened.length, 1, 'one open anomaly, not one per sample');
  assert.equal(opened[0].classification, 'MEMORY_USAGE_ANOMALY');

  // Continued deviation updates the same anomaly rather than creating new ones.
  const continued = await send(75, 900);
  assert.equal(continued.length, 1);
  assert.equal(continued[0].status, 'ACTIVE');
  assert.equal(continued[0].anomalyId, opened[0].anomalyId);
  assert.equal(continued[0].dedupeKey, opened[0].dedupeKey);

  // Recovery is gradual, and a single normal window does not resolve anything.
  const recovery = [];
  for (const offset of [90, 105, 120, 135, 150, 165])
    recovery.push(...(await send(offset, 400)));
  const resolved = recovery.filter((anomaly) => anomaly.status === 'RESOLVED');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].anomalyId, opened[0].anomalyId);
  assert.equal(
    recovery.filter((anomaly) => anomaly.status !== 'RESOLVED').length,
    recovery.length - 1,
  );

  // Cooldown keeps the same signal quiet even though it is abnormal again.
  const flapping = [];
  for (const offset of [180, 195, 210, 225, 240])
    flapping.push(...(await send(offset, 900)));
  assert.equal(
    flapping.some((anomaly) => anomaly.status === 'OPEN'),
    false,
    'no reopen during cooldown',
  );

  // Past the cooldown the signal may open again.
  const afterCooldown = [];
  for (const offset of [800, 815, 830, 845, 860])
    afterCooldown.push(...(await send(offset, 900)));
  assert.equal(
    afterCooldown.some((anomaly) => anomaly.status === 'OPEN'),
    true,
  );
});

test('severity grows with duration and blast radius', async () => {
  const seeded = [
    baselineOf({
      metricName: 'k8s.container.cpu.usage',
      mean: 0.2,
      standardDeviation: 0.02,
      unit: 'cores',
    }),
  ];
  const { detector } = await detectorWith(seeded);
  const base = Date.now() - 1_800_000;
  const emitted = await feed(
    detector,
    series(20, () => 0.6, base).map((sample) =>
      metricEvent('k8s.container.cpu.usage', sample.value, sample.timestamp),
    ),
  );
  const first = emitted.find((anomaly) => anomaly.status === 'OPEN');
  const last = emitted.at(-1);
  assert.equal(first.severity, 'WARNING', 'a short single-replica spike stays low');
  assert.ok(
    ['HIGH', 'CRITICAL'].includes(last.severity),
    `sustained deviation escalates, got ${last.severity}`,
  );
  assert.ok(last.confidence >= first.confidence);
});

test('a redelivered event is not counted twice', async () => {
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.cpu.usage',
      mean: 0.2,
      standardDeviation: 0.02,
      unit: 'cores',
    }),
  ]);
  const base = Date.now() - 600_000;
  const events = series(4, () => 0.5, base).map((sample) =>
    metricEvent('k8s.container.cpu.usage', sample.value, sample.timestamp),
  );
  for (const event of events) await detector.detect(event);
  // Replaying every event must not advance the consecutive-window counters.
  const replay = [];
  for (const event of events) replay.push(...(await detector.detect(event)));
  assert.deepEqual(replay, []);
});

test('detector state survives a restart through export and import', async () => {
  const seeded = [
    baselineOf({
      metricName: 'k8s.container.cpu.usage',
      mean: 0.2,
      standardDeviation: 0.02,
      unit: 'cores',
    }),
  ];
  const { detector, provider } = await detectorWith(seeded);
  const base = Date.now() - 600_000;
  const events = series(4, () => 0.5, base).map((sample) =>
    metricEvent('k8s.container.cpu.usage', sample.value, sample.timestamp),
  );
  for (const event of events) await detector.detect(event);
  const snapshot = JSON.parse(JSON.stringify(detector.exportState()));

  const restarted = new InMemoryStatisticalDetector(provider, detectionConfig());
  restarted.importState(snapshot);
  // The fifth sample opens the anomaly because the earlier four were restored.
  const emitted = await restarted.detect(
    metricEvent('k8s.container.cpu.usage', 0.5, base + 4 * 15_000),
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].status, 'OPEN');
});

test('baseline refresh persists per-workload baselines and drops stale rows', async () => {
  const requests = [];
  const history = {
    listBaselineTargets: async () => [
      workload,
      { ...workload, workload: 'search-api' },
    ],
    summarizeMetric: async (request) => {
      requests.push(request);
      return {
        sampleCount: 720,
        unit: 'By',
        statistics: {
          sampleCount: 720,
          mean: 400 * MiB,
          min: 320 * MiB,
          max: 500 * MiB,
          standardDeviation: 25 * MiB,
          p50: 398 * MiB,
          p95: 445 * MiB,
          p99: 470 * MiB,
        },
      };
    },
    findDisruptionWindows: async () => [],
  };
  const repository = new InMemoryBaselineRepository();
  const engine = new BaselineEngine(history, repository, {
    windows: { default: '24h', fast: '1h' },
    minimumSamples: 60,
    bucketMs: 60_000,
    maxTargets: 50,
    maxSamplesPerSummary: 100_000,
    excludeDisruptedPeriods: false,
    disruptionPaddingMs: 0,
    disruptionReasons: [],
  });
  const result = await engine.refresh();
  assert.equal(result.targets, 2);
  assert.equal(result.ready, baselineMetricDefinitions.length * 2);

  // Baselines are per workload; unrelated services are never compared to each other.
  const payment = await repository.listForWorkload(workload);
  const search = await repository.listForWorkload({
    ...workload,
    workload: 'search-api',
  });
  assert.equal(payment.length, baselineMetricDefinitions.length);
  assert.equal(search.length, baselineMetricDefinitions.length);
  assert.ok(payment.every((item) => item.workload === 'payment-api'));

  // Windows are configurable per signal speed, not one universal horizon.
  const memory = payment.find(
    (item) => item.metricName === 'k8s.container.memory.usage',
  );
  const errors = payment.find(
    (item) => item.metricName === 'faultline.workload.log_error_rate',
  );
  assert.equal(memory.window, '24h');
  assert.equal(errors.window, '1h');
  assert.equal(memory.status, 'READY');
  assert.equal(memory.statistics.p95, 445 * MiB);
  assert.ok(
    requests.some((request) => request.source.kind === 'ratio'),
    'memory utilization is derived from usage over limit',
  );
  assert.ok(
    requests.some((request) => request.source.kind === 'counter-rate'),
    'restart and network signals are read as rates',
  );

  // Re-running updates in place rather than duplicating.
  await engine.refresh();
  assert.equal(
    (await repository.listForWorkload(workload)).length,
    baselineMetricDefinitions.length,
  );

  // Workloads that stop reporting eventually age out.
  const removed = await repository.deleteStale(iso(Date.now() + 60_000));
  assert.equal(removed, baselineMetricDefinitions.length * 2);
  assert.equal((await repository.list()).length, 0);
});

test('baselines exclude periods Faultline already knew were abnormal', async () => {
  const seen = [];
  const disruption = {
    startTime: iso(Date.parse('2026-09-09T02:00:00Z')),
    endTime: iso(Date.parse('2026-09-09T02:30:00Z')),
  };
  const incidentWindow = {
    startTime: iso(Date.parse('2026-09-09T02:20:00Z')),
    endTime: iso(Date.parse('2026-09-09T03:00:00Z')),
  };
  const history = {
    listBaselineTargets: async () => [workload],
    summarizeMetric: async (request) => {
      seen.push(request.exclude);
      return { sampleCount: 0 };
    },
    findDisruptionWindows: async () => [disruption],
  };
  const engine = new BaselineEngine(
    history,
    new InMemoryBaselineRepository(),
    {
      windows: { default: '24h', fast: '1h' },
      minimumSamples: 60,
      bucketMs: 60_000,
      maxTargets: 10,
      maxSamplesPerSummary: 1000,
      excludeDisruptedPeriods: true,
      disruptionPaddingMs: 300_000,
      disruptionReasons: ['OOMKilling', 'BackOff'],
    },
    async () => [incidentWindow],
  );
  const result = await engine.refresh();
  assert.ok(result.excludedRanges > 0);
  // Overlapping incident and Kubernetes-event windows merge into one range, so an
  // event storm costs one exclusion rather than hundreds.
  assert.deepEqual(seen[0], [
    { startTime: disruption.startTime, endTime: incidentWindow.endTime },
  ]);

  // Disabling exclusion is a supported, explicit choice.
  const unfiltered = [];
  const plain = new BaselineEngine(
    {
      ...history,
      summarizeMetric: async (request) => {
        unfiltered.push(request.exclude);
        return { sampleCount: 0 };
      },
    },
    new InMemoryBaselineRepository(),
    {
      windows: { default: '24h', fast: '1h' },
      minimumSamples: 60,
      bucketMs: 60_000,
      maxTargets: 10,
      maxSamplesPerSummary: 1000,
      excludeDisruptedPeriods: false,
      disruptionPaddingMs: 300_000,
      disruptionReasons: ['OOMKilling'],
    },
    async () => [incidentWindow],
  );
  await plain.refresh();
  assert.deepEqual(unfiltered[0], []);

  assert.deepEqual(
    mergeRanges([
      { startTime: iso(0), endTime: iso(1000) },
      { startTime: iso(500), endTime: iso(2000) },
      { startTime: iso(5000), endTime: iso(6000) },
    ]),
    [
      { startTime: iso(0), endTime: iso(2000) },
      { startTime: iso(5000), endTime: iso(6000) },
    ],
  );
});

test('telemetry without a matching signal contributes nothing', async () => {
  const base = Date.now();
  // Kubernetes events are not a statistical signal; they belong to the rule engine.
  assert.deepEqual(
    contributionsFor({
      kind: 'kubernetes',
      id: 'k8s-1',
      timestamp: iso(base),
      clusterId: workload.clusterId,
      namespace: workload.namespace,
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off',
      involvedObject: {
        clusterId: workload.clusterId,
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'payment-api-7d9f',
      },
      attributes: {},
      raw: null,
    }),
    [],
  );
  // A metric Faultline does not baseline is ignored rather than guessed at.
  assert.deepEqual(
    contributionsFor(metricEvent('k8s.container.cpu.limit', 2, base)),
    [],
  );
  // Network samples without a direction attribute cannot be attributed.
  assert.deepEqual(
    contributionsFor(metricEvent('k8s.pod.network.io', 100, base)),
    [],
  );

  // Telemetry that cannot be attributed to a workload has nothing to compare against.
  const { detector } = await detectorWith([
    baselineOf({
      metricName: 'k8s.container.cpu.usage',
      mean: 0.2,
      standardDeviation: 0.02,
    }),
  ]);
  const orphaned = await feed(
    detector,
    series(6, () => 0.5, base - 600_000).map((sample) =>
      metricEvent('k8s.container.cpu.usage', sample.value, sample.timestamp, {
        workload: undefined,
      }),
    ),
  );
  assert.deepEqual(orphaned, []);
});

test('the baselines API scopes by cluster and explains unready baselines', async () => {
  const repository = new InMemoryBaselineRepository();
  await repository.save([
    baselineOf({
      metricName: 'k8s.container.memory.usage',
      mean: 410 * MiB,
      standardDeviation: 22 * MiB,
      unit: 'By',
    }),
    baselineOf({
      metricName: 'http.server.duration',
      mean: 0,
      standardDeviation: 0,
      status: 'BASELINE_NOT_READY',
      sampleCount: 11,
      window: '1h',
    }),
    {
      ...baselineOf({
        metricName: 'k8s.container.memory.usage',
        mean: 100 * MiB,
        standardDeviation: 5 * MiB,
      }),
      clusterId: 'another-tenant',
    },
  ]);
  const config = {
    application: 'api',
    environment: 'test',
    telemetryStorage: {
      queryLimits: defaultQueryLimits,
      queryClusterScope: [workload.clusterId],
    },
  };
  const controller = new BaselinesController(
    repository,
    new ConfiguredTelemetryScopeResolver(config),
    silentLogger,
  );

  const listed = await controller.list({});
  assert.equal(listed.items.length, 2, 'another tenant is invisible');
  assert.ok(listed.items.every((item) => item.clusterId === workload.clusterId));
  const memory = listed.items.find(
    (item) => item.metricName === 'k8s.container.memory.usage',
  );
  assert.equal(memory.label, 'Memory usage');
  assert.equal(memory.status, 'READY');
  assert.equal(memory.sampleCount, 1440);
  assert.equal(memory.p95, 410 * MiB + 44 * MiB);
  assert.equal(memory.window, '24h');
  assert.ok(memory.updatedAt);

  const unready = listed.items.find(
    (item) => item.metricName === 'http.server.duration',
  );
  assert.equal(unready.status, 'BASELINE_NOT_READY');
  assert.equal(unready.mean, undefined, 'unusable statistics are not served');

  const single = await controller.get(
    `workload:${workload.clusterId}:${workload.namespace}:${workload.workload}`,
    'k8s.container.memory.usage',
    undefined,
  );
  assert.equal(single.items.length, 1);
  assert.equal(single.items[0].mean, 410 * MiB);

  await assert.rejects(
    controller.get(
      'workload:another-tenant:payments:payment-api',
      'k8s.container.memory.usage',
      undefined,
    ),
    (error) => error.getStatus() === 403,
  );
  await assert.rejects(
    controller.get('not-a-resource', 'k8s.container.memory.usage', undefined),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    controller.get(
      `workload:${workload.clusterId}:${workload.namespace}:${workload.workload}`,
      'k8s.container.cpu.usage',
      undefined,
    ),
    (error) => error.getStatus() === 404,
  );
  await assert.rejects(
    controller.list({ window: '3h' }),
    (error) => error.getStatus() === 400,
  );
});

test('gradual memory growth, a hard threshold and an OOM kill correlate into one incident', async () => {
  const clusterId = 'scenario-cluster';
  const namespace = 'payments';
  const workloadName = 'payment-api';
  const pod = 'payment-api-6b4c';
  const container = 'api';
  const limitBytes = 1024 * MiB;
  // Resource state expires relative to event time, so the scenario runs recently.
  const base = Math.floor(Date.now() / 1000) * 1000 - 600_000;
  const at = (offset) => iso(base + offset);

  // 1. payment-api's normal memory becomes a baseline from telemetry history.
  const repository = new InMemoryBaselineRepository();
  const engine = new BaselineEngine(
    {
      listBaselineTargets: async () => [
        { clusterId, namespace, workload: workloadName },
      ],
      summarizeMetric: async (request) =>
        request.source.kind === 'gauge' &&
        request.source.metricName === 'k8s.container.memory.usage'
          ? {
              sampleCount: 1440,
              unit: 'By',
              statistics: {
                sampleCount: 1440,
                mean: 400 * MiB,
                min: 340 * MiB,
                max: 470 * MiB,
                standardDeviation: 30 * MiB,
                p50: 398 * MiB,
                p95: 448 * MiB,
                p99: 462 * MiB,
              },
            }
          : { sampleCount: 0 },
      findDisruptionWindows: async () => [],
    },
    repository,
    {
      windows: { default: '24h', fast: '1h' },
      minimumSamples: 60,
      bucketMs: 60_000,
      maxTargets: 10,
      maxSamplesPerSummary: 100_000,
      excludeDisruptedPeriods: false,
      disruptionPaddingMs: 0,
      disruptionReasons: [],
    },
  );
  await engine.refresh();
  const memoryBaseline = await repository.get({
    clusterId,
    namespace,
    workload: workloadName,
    resourceType: 'container',
    metricName: 'k8s.container.memory.usage',
    window: '24h',
    season: { kind: 'all' },
  });
  assert.equal(memoryBaseline.status, 'READY');

  const incidents = new InMemoryIncidentRepository();
  const thresholds = {
    memoryWarningPercent: 85,
    memoryCriticalPercent: 95,
    cpuWarningPercent: 80,
    cpuCriticalPercent: 95,
    restartThreshold: 3,
    notReadyDurationMs: 60_000,
    deploymentDegradationDurationMs: 120_000,
  };
  const consumer = new TelemetryConsumer(
    new InMemoryQueue(),
    silentLogger,
    new InMemoryResourceState(),
    new InMemoryRuleEngine(createDefaultRules(), thresholds),
    new IncidentCorrelationEngine(incidents, {
      correlationWindowMs: 900_000,
      stabilizationPeriodMs: 120_000,
    }),
    undefined,
    new InMemoryStatisticalDetector(
      new CachedBaselineProvider(repository, 60_000),
      detectionConfig({ evaluationWindowMs: 1_800_000 }),
    ),
  );

  const common = {
    clusterId,
    namespace,
    workload: workloadName,
    pod,
    container,
    node: 'node-a',
    service: workloadName,
    attributes: { 'k8s.pod.uid': 'payment-uid' },
    raw: null,
  };
  const deliver = (payload) =>
    consumer.process({ id: payload.id, payload: { ...common, ...payload } });

  // 2. Memory climbs steadily, then past the hard limit thresholds. The limit is
  // re-reported on every scrape, exactly as kubelet does, because resource state
  // expires per field and a stale limit would leave utilization unknown.
  const climb = [310, 360, 410, 470, 540, 620, 700, 790, 880, 960, 1000];
  for (const [index, mib] of climb.entries()) {
    const offset = index * 15_000;
    await deliver({
      kind: 'metric',
      id: `limit-${index}`,
      timestamp: at(offset),
      ingestedAt: at(offset),
      name: 'k8s.container.memory.limit',
      value: limitBytes,
      unit: 'By',
      metricType: 'gauge',
      category: 'configuration',
    });
    await deliver({
      kind: 'metric',
      id: `usage-${index}`,
      timestamp: at(offset + 1000),
      ingestedAt: at(offset + 1000),
      name: 'k8s.container.memory.usage',
      value: mib * MiB,
      unit: 'By',
      metricType: 'gauge',
      category: 'usage',
    });
  }

  // 3. The container is finally OOM killed.
  await deliver({
    kind: 'kubernetes',
    id: 'oom',
    timestamp: at(climb.length * 15_000),
    ingestedAt: at(climb.length * 15_000),
    type: 'Warning',
    reason: 'OOMKilled',
    message: 'Container api was OOM killed',
    count: 1,
    involvedObject: {
      clusterId,
      apiVersion: 'v1',
      kind: 'Pod',
      name: pod,
      namespace,
      uid: 'payment-uid',
    },
  });

  // 4. Every signal landed in one incident, through the existing correlation engine.
  const stored = await incidents.listIncidents({ clusterId });
  assert.equal(stored.length, 1, 'one incident, not one per detector');
  const incident = stored[0];
  assert.equal(incident.classification, 'MEMORY_EXHAUSTION');

  const classifications = new Set(
    incident.anomalies.map((anomaly) => anomaly.classification),
  );
  assert.ok(
    classifications.has('MEMORY_GROWTH_ANOMALY'),
    `growth was detected, got ${[...classifications].join(', ')}`,
  );
  assert.ok(classifications.has('HIGH_MEMORY_UTILIZATION'));
  assert.ok(classifications.has('OOM_KILLED'));

  // 5. Both kinds of evidence survive into the incident and stay attributable.
  const sources = new Set(incident.anomalies.map((anomaly) => anomaly.source));
  assert.deepEqual([...sources].sort(), ['DETERMINISTIC', 'STATISTICAL']);
  assert.ok(incident.evidence.some((entry) => entry.source === 'STATISTICAL'));
  assert.ok(incident.evidence.some((entry) => entry.source === 'DETERMINISTIC'));
  const baselineEvidence = incident.evidence.find(
    (entry) => entry.type === 'baseline',
  );
  assert.ok(baselineEvidence, 'the incident retains the expected-behaviour numbers');
  assert.equal(baselineEvidence.attributes.metric, 'k8s.container.memory.usage');
  assert.equal(baselineEvidence.attributes.p95, 448 * MiB);
  assert.ok(baselineEvidence.attributes.sampleCount >= 60);

  // Statistical corroboration raises confidence above the deterministic-only case.
  assert.ok(incident.confidence >= 0.85);
  assert.ok(
    incident.timeline.some((entry) => entry.source === 'STATISTICAL'),
    'the timeline distinguishes statistical from deterministic entries',
  );
});
