// Read-only verification against the documented local development deployment.
const { execFileSync } = require('node:child_process');
const context = process.env.FAULTLINE_KUBE_CONTEXT || 'kind-faultline';
const cluster = process.env.FAULTLINE_CLUSTER_ID || 'development-cluster';
const kubeconfig = process.env.KUBECONFIG;
const args = [
  ...(kubeconfig ? ['--kubeconfig', kubeconfig] : []),
  '--context',
  context,
  '-n',
  'faultline-system',
  'logs',
  'deployment/faultline-dev',
  '--since=5m',
];
(async () => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    let output;
    try {
      output = execFileSync('kubectl', args, {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(
        'Cannot read Faultline logs; check context, deployment and kubeconfig',
      );
    }
    const entries = output.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line).message];
      } catch {
        return [];
      }
    });
    const results = entries.filter(
      (entry) =>
        entry?.event === 'telemetry_processed' &&
        entry.cluster_id === cluster &&
        entry.namespace === 'faultline-demo',
    );
    const log = (stream) =>
      results.find(
        (entry) =>
          entry.type === 'LOG' &&
          entry.stream === stream &&
          entry.pod &&
          entry.container === 'demo' &&
          entry.node &&
          entry.pod_uid &&
          entry.container_id &&
          entry.telemetry_message?.includes('faultline-demo'),
      );
    const event = results.find(
      (entry) =>
        entry.type === 'KUBERNETES_EVENT' &&
        [
          'Started',
          'Pulling',
          'BackOff',
          'Failed',
          'Unhealthy',
          'FailedScheduling',
          'FailedMount',
          'Evicted',
        ].includes(entry.reason) &&
        entry.pod,
    );
    if (log('stdout') && log('stderr') && event) {
      console.log(
        JSON.stringify(
          {
            status: 'verified',
            cluster,
            stdout: log('stdout'),
            stderr: log('stderr'),
            kubernetesEvent: event,
          },
          null,
          2,
        ),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    'Missing enriched stdout/stderr or Kubernetes event in last five minutes; start collectors before restarting the demo workload, enable demo message logging, and inspect collector export errors',
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
