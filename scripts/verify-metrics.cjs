// Read-only, real Kubernetes evidence. Never synthesizes telemetry.
const { execFileSync } = require('node:child_process');
const context = process.env.FAULTLINE_KUBE_CONTEXT || 'kind-faultline';
const cluster = process.env.FAULTLINE_CLUSTER_ID || 'development-cluster';
const kube = (...args) =>
  execFileSync('kubectl', ['--context', context, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
async function verify() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const pods = JSON.parse(
      kube(
        '-n',
        'faultline-demo',
        'get',
        'pods',
        '-l',
        'app=telemetry-demo',
        '-o',
        'json',
      ),
    );
    const pod = pods.items.find(
      (item) =>
        !item.metadata.deletionTimestamp && item.status.phase === 'Running',
    );
    const entries = kube(
      '-n',
      'faultline-system',
      'logs',
      'deployment/faultline-dev',
      '--since=2m',
    )
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          return [JSON.parse(line).message];
        } catch {
          return [];
        }
      });
    const states = entries.filter(
      (entry) =>
        entry?.event === 'resource_state_updated' &&
        entry.resource.clusterId === cluster &&
        entry.resource.podUid === pod?.metadata.uid &&
        entry.resource.container === 'demo',
    );
    const state = states.at(-1)?.resource;
    const required = [
      'cpuUsage',
      'memoryUsage',
      'cpuLimit',
      'memoryLimit',
      'restartCount',
      'ready',
      'containerState',
    ];
    const complete =
      state &&
      state.workload === 'telemetry-demo' &&
      state.restartCount ===
        pod?.status.containerStatuses?.find((item) => item.name === 'demo')
          ?.restartCount &&
      state.ready ===
        pod?.status.containerStatuses?.find((item) => item.name === 'demo')
          ?.ready &&
      required.every((key) => state[key] !== undefined) &&
      Object.values(state.fieldTimestamps).every(
        (timestamp) => Date.now() - Date.parse(timestamp) < 120000,
      );
    const metrics = entries.filter(
      (entry) =>
        entry?.event === 'telemetry_processed' &&
        entry.type === 'METRIC' &&
        entry.cluster_id === cluster,
    );
    const coverage = {
      podCpu: metrics.some(
        (entry) =>
          entry.metric === 'k8s.pod.cpu.usage' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      podMemory: metrics.some(
        (entry) =>
          entry.metric === 'k8s.pod.memory.usage' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      nodeCpu: metrics.some((entry) => entry.metric === 'k8s.node.cpu.usage'),
      nodeMemory: metrics.some(
        (entry) => entry.metric === 'k8s.node.memory.usage',
      ),
      networkReceive: metrics.some(
        (entry) =>
          entry.metric === 'k8s.pod.network.io' &&
          entry.direction === 'receive' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      networkTransmit: metrics.some(
        (entry) =>
          entry.metric === 'k8s.pod.network.io' &&
          entry.direction === 'transmit' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      filesystem: metrics.some(
        (entry) =>
          entry.metric === 'k8s.container.filesystem.usage' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      nodeCondition: metrics.some(
        (entry) => entry.metric === 'k8s.node.condition_ready',
      ),
      deploymentDesired: metrics.some(
        (entry) =>
          entry.metric === 'k8s.deployment.replicas.desired' &&
          entry.namespace === 'faultline-demo',
      ),
      deploymentAvailable: metrics.some(
        (entry) =>
          entry.metric === 'k8s.deployment.replicas.available' &&
          entry.namespace === 'faultline-demo',
      ),
      deploymentUnavailable: metrics.some(
        (entry) =>
          entry.metric === 'k8s.deployment.replicas.unavailable' &&
          entry.namespace === 'faultline-demo',
      ),
      podReady: metrics.some(
        (entry) =>
          entry.metric === 'k8s.pod.ready' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      podPhase: metrics.some(
        (entry) =>
          entry.metric === 'k8s.pod.phase' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      cpuRequest: metrics.some(
        (entry) =>
          entry.metric === 'k8s.container.cpu.request' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
      memoryRequest: metrics.some(
        (entry) =>
          entry.metric === 'k8s.container.memory.request' &&
          entry.pod_uid === pod?.metadata.uid,
      ),
    };
    if (complete && Object.values(coverage).every(Boolean)) {
      console.log(
        JSON.stringify(
          {
            status: 'verified',
            observedAt: new Date().toISOString(),
            context,
            cluster,
            kubernetes: {
              pod: pod.metadata.name,
              uid: pod.metadata.uid,
              container: 'demo',
              resources: pod.spec.containers.find(
                (item) => item.name === 'demo',
              ).resources,
              status: pod.status.containerStatuses.find(
                (item) => item.name === 'demo',
              ),
            },
            coverage,
            resourceState: state,
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
    'Missing current resource state or metric coverage; inspect Collector exports and processor logs',
  );
}
verify().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
