if (process.env.NODE_ENV !== 'development')
  throw new Error('Set NODE_ENV=development to run samples');
const token = process.env.FAULTLINE_DEV_AGENT_TOKEN;
if (!token) throw new Error('FAULTLINE_DEV_AGENT_TOKEN is required');
const base = process.env.FAULTLINE_INGESTION_URL || 'http://127.0.0.1:3001';
const clusterId = process.env.FAULTLINE_CLUSTER_ID || 'development-cluster';
const common = {
  timestamp: new Date().toISOString(),
  namespace: 'default',
  pod: 'payment-api-1',
  container: 'app',
  service: 'payment-api',
};
const samples = [
  ['logs', { level: 'info', message: 'Payment completed', stream: 'stdout' }],
  [
    'logs',
    {
      level: 'error',
      message: 'Payment provider timeout',
      stream: 'stderr',
      raw: { code: 'ETIMEDOUT' },
    },
  ],
  ['metrics', { name: 'k8s.container.cpu.usage', value: 0.42, unit: 'cores' }],
  [
    'metrics',
    { name: 'k8s.container.memory.usage', value: 268435456, unit: 'By' },
  ],
  ...['BackOff', 'OOMKilled'].map((reason) => [
    'kubernetes-events',
    {
      type: 'Warning',
      reason,
      message:
        reason === 'BackOff'
          ? 'Back-off restarting failed container'
          : 'Container terminated because memory limit was exceeded',
      count: 1,
      involvedObject: {
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'payment-api-1',
        namespace: 'default',
      },
    },
  ]),
];
(async () => {
  for (const [route, payload] of samples) {
    const response = await fetch(`${base}/v1/telemetry/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Faultline-Cluster-ID': clusterId,
        'X-Faultline-Agent-Token': token,
      },
      body: JSON.stringify({ ...common, ...payload }),
      signal: AbortSignal.timeout(5000),
    });
    console.log(
      JSON.stringify({
        route,
        status: response.status,
        acknowledgement: await response.json(),
      }),
    );
    if (!response.ok) process.exitCode = 1;
  }
})().catch(() => {
  console.error(
    'Sample request failed; check the pipeline URL and configuration',
  );
  process.exitCode = 1;
});
