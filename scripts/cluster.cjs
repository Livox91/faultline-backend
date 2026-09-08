const {
  root,
  resolve,
  run,
  parseArgs,
  parseEnv,
  loadState,
  saveState,
  requestJson,
  publicEndpoint,
  kubeArgs,
} = require('./onboarding/lib.cjs');

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const kubectl = (state, values, options = {}) =>
  run('kubectl', kubeArgs(state, ...values), options);

function inferredEndpoint(context) {
  return context?.startsWith('minikube')
    ? 'http://host.minikube.internal:3001'
    : 'http://host.docker.internal:3001';
}

function register() {
  const current = run('kubectl', ['config', 'current-context'], {
    timeout: 10_000,
    message:
      'kubectl has no current context. Select one with kubectl config use-context <name>.',
  });
  const prior = (() => {
    try {
      return loadState();
    } catch {
      return {};
    }
  })();
  const ingestion = parseEnv(resolve(root, 'apps/ingestion/.env'));
  const token = ingestion.FAULTLINE_DEV_AGENT_TOKEN;
  if (!token)
    throw new Error('Missing generated agent token. Run: npm run setup');
  const state = {
    version: 1,
    clusterId: args.id || prior.clusterId || 'booknest-development',
    clusterName: args.name || prior.clusterName || 'BookNest local cluster',
    context: args.context || current,
    ingestionEndpoint:
      args.endpoint ||
      (prior.context === current ? prior.ingestionEndpoint : undefined) ||
      inferredEndpoint(current),
    token,
    workloadNamespace:
      args['workload-namespace'] || prior.workloadNamespace || 'default',
    workloadLabel:
      args['workload-label'] || prior.workloadLabel || 'app=booknest-backend',
    insecureKubelet:
      Boolean(args['insecure-kubelet']) ||
      Boolean(prior.insecureKubelet) ||
      /^(kind-|minikube)/.test(args.context || current),
  };
  new URL(state.ingestionEndpoint);
  saveState(state);
  console.log(`Registered ${state.clusterName} (${state.clusterId}).`);
  console.log(`kubectl context: ${state.context}`);
  console.log(`Ingestion endpoint: ${state.ingestionEndpoint}`);
  console.log('The agent token was stored locally and was not printed.');
}

async function connectivity(state) {
  kubectl(state, ['get', '--raw=/version'], {
    timeout: 10_000,
    message: `Kubernetes context ${state.context} is unreachable. Start the cluster or select a reachable context.`,
  });
  const name = `faultline-connectivity-${process.pid}`;
  const endpoint = `${publicEndpoint(state.ingestionEndpoint)}/health/ready`;
  try {
    try {
      kubectl(
        state,
        ['delete', 'pod', name, '-n', 'default', '--ignore-not-found=true'],
        { timeout: 20_000 },
      );
    } catch {}
    kubectl(
      state,
      [
        'run',
        name,
        '--namespace=default',
        '--image=curlimages/curl:8.12.1',
        '--restart=Never',
        '--command',
        '--',
        'curl',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        endpoint,
      ],
      { timeout: 30_000 },
    );
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const phase = kubectl(
        state,
        ['get', 'pod', name, '-n', 'default', '-o', 'jsonpath={.status.phase}'],
        { timeout: 10_000 },
      );
      if (phase === 'Succeeded') {
        console.log(`✓ Kubernetes can reach ${endpoint}`);
        return;
      }
      if (phase === 'Failed') {
        const logs = kubectl(state, ['logs', name, '-n', 'default'], {
          timeout: 10_000,
        });
        throw new Error(logs || 'connectivity pod failed');
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
    throw new Error('connectivity pod timed out');
  } catch (error) {
    throw new Error(
      `Kubernetes cannot reach Faultline ingestion at ${endpoint}. Do not use localhost. For Docker Desktop/kind use host.docker.internal; for Minikube use host.minikube.internal; for a remote cluster supply a routable HTTPS URL. Detail: ${error.message}`,
    );
  } finally {
    try {
      kubectl(
        state,
        ['delete', 'pod', name, '-n', 'default', '--ignore-not-found=true'],
        { timeout: 20_000 },
      );
    } catch {}
  }
}

function applyJson(state, resource) {
  kubectl(state, ['apply', '-f', '-'], {
    input: JSON.stringify(resource),
    timeout: 30_000,
  });
}

async function install() {
  const state = loadState();
  await connectivity(state);
  applyJson(state, {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'faultline-system' },
  });
  applyJson(state, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'faultline-agent', namespace: 'faultline-system' },
    type: 'Opaque',
    stringData: { token: state.token },
  });
  const base = publicEndpoint(state.ingestionEndpoint);
  applyJson(state, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'faultline-connection', namespace: 'faultline-system' },
    data: {
      'cluster-id': state.clusterId,
      'logs-endpoint': `${base}/v1/otlp/logs`,
      'metrics-endpoint': `${base}/v1/otlp/metrics`,
    },
  });
  kubectl(state, ['apply', '-k', 'deploy/kubernetes'], {
    timeout: 120_000,
    message:
      'Collector installation failed. Verify kubectl permissions for namespaces, RBAC, DaemonSets and Deployments.',
  });
  if (state.insecureKubelet)
    kubectl(state, [
      '-n',
      'faultline-system',
      'set',
      'env',
      'daemonset/faultline-collector-logs',
      'KUBELET_INSECURE_SKIP_VERIFY=true',
    ]);
  kubectl(
    state,
    [
      '-n',
      'faultline-system',
      'rollout',
      'status',
      'daemonset/faultline-collector-logs',
      '--timeout=180s',
    ],
    { timeout: 200_000 },
  );
  kubectl(
    state,
    [
      '-n',
      'faultline-system',
      'rollout',
      'status',
      'deployment/faultline-collector-events',
      '--timeout=180s',
    ],
    { timeout: 200_000 },
  );
  console.log('Faultline collectors installed and rolled out.');
}

function collectorStatus(state) {
  const daemonSet = JSON.parse(
    kubectl(state, [
      '-n',
      'faultline-system',
      'get',
      'daemonset/faultline-collector-logs',
      '-o',
      'json',
    ]),
  );
  const deployment = JSON.parse(
    kubectl(state, [
      '-n',
      'faultline-system',
      'get',
      'deployment/faultline-collector-events',
      '-o',
      'json',
    ]),
  );
  const desired = daemonSet.status.desiredNumberScheduled ?? 0;
  const ready = daemonSet.status.numberReady ?? 0;
  const eventReady = deployment.status.readyReplicas ?? 0;
  if (!desired || ready !== desired)
    throw new Error(
      `Log collector is not ready (${ready}/${desired}). Inspect: kubectl -n faultline-system describe daemonset faultline-collector-logs`,
    );
  if (eventReady !== (deployment.spec.replicas ?? 1))
    throw new Error(
      'Event collector is not ready. Inspect: kubectl -n faultline-system describe deployment faultline-collector-events',
    );
  const logs = kubectl(state, [
    '-n',
    'faultline-system',
    'logs',
    'daemonset/faultline-collector-logs',
    '--all-containers=true',
    '--since=2m',
    '--prefix=true',
  ]);
  const exportFailures = logs
    .split(/\r?\n/)
    .filter((line) =>
      /export.*failed|sending queue.*full|unauthorized/i.test(line),
    );
  if (exportFailures.length >= 3)
    throw new Error(
      `Collector is repeatedly failing exports (${exportFailures.length} recent errors). Check the endpoint and token, then restart the collector.`,
    );
  return { desired, ready, eventReady };
}

async function verify() {
  const state = loadState();
  await Promise.all(
    [3000, 3001, 3002, 3003].map((port) =>
      requestJson(`http://127.0.0.1:${port}/health/ready`, { timeout: 3_000 }),
    ),
  ).catch(() => {
    throw new Error(
      'Faultline services are not ready. Start them with: npm run faultline:start',
    );
  });
  await connectivity(state);
  const collector = collectorStatus(state);
  const workloadPods = JSON.parse(
    kubectl(state, [
      '-n',
      state.workloadNamespace,
      'get',
      'pods',
      '-l',
      state.workloadLabel,
      '-o',
      'json',
    ]),
  ).items;
  if (!workloadPods.length)
    throw new Error(
      `No BookNest pods match ${state.workloadLabel} in namespace ${state.workloadNamespace}. Deploy BookNest or update registration with --workload-namespace and --workload-label.`,
    );

  kubectl(state, ['apply', '-f', 'deploy/kubernetes/onboarding-test.yaml'], {
    timeout: 30_000,
  });
  kubectl(
    state,
    [
      '-n',
      'faultline-onboarding',
      'rollout',
      'status',
      'deployment/faultline-log-test',
      '--timeout=120s',
    ],
    { timeout: 140_000 },
  );

  const deadline = Date.now() + 120_000;
  let received;
  let classified;
  while (Date.now() < deadline && (!received || !classified)) {
    const startTime = new Date(Date.now() - 10 * 60_000).toISOString();
    const endTime = new Date(Date.now() + 60_000).toISOString();
    const query = new URLSearchParams({
      clusterId: state.clusterId,
      namespace: 'faultline-onboarding',
      search: 'FAULTLINE_ONBOARDING_TEST',
      startTime,
      endTime,
      limit: '20',
    });
    try {
      const logs = await requestJson(
        `http://127.0.0.1:3000/telemetry/logs?${query}`,
        { timeout: 5_000 },
      );
      received = logs.items?.find((item) =>
        item.message.includes('FAULTLINE_ONBOARDING_TEST'),
      );
      const incidents = await requestJson(
        `http://127.0.0.1:3000/incidents?cluster=${encodeURIComponent(state.clusterId)}&classification=APPLICATION_DEPENDENCY_FAILURE`,
        { timeout: 5_000 },
      );
      classified = incidents.find((incident) =>
        incident.anomalies?.some(
          (anomaly) =>
            anomaly.classification === 'DATABASE_CONNECTIVITY' &&
            anomaly.affectedResource.namespace === 'faultline-onboarding',
        ),
      );
    } catch {}
    if (!received || !classified)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  }
  if (!received)
    throw new Error(
      'The onboarding log did not reach ClickHouse. Inspect collector logs, ingestion health, NATS, and storage readiness.',
    );
  if (!classified)
    throw new Error(
      'The database-connectivity log arrived but no DATABASE_CONNECTIVITY classification was found. Inspect .local/faultline.log.',
    );

  console.log('\nFAULTLINE ONBOARDING COMPLETE\n');
  console.log(`Cluster: ${state.clusterName} (${state.clusterId})`);
  console.log(
    `BookNest: ${workloadPods.length} pod(s) discovered in ${state.workloadNamespace}`,
  );
  console.log(`Collector: Healthy (${collector.ready}/${collector.desired})`);
  console.log('Faultline ingestion: Healthy');
  console.log('Processor: Healthy');
  console.log('Telemetry storage: Healthy');
  console.log(`First log: Received from ${received.pod}`);
  console.log('Log classification: DATABASE_CONNECTIVITY');
  console.log('Kubernetes → Faultline: CONNECTED');
}

function cleanup() {
  const state = loadState();
  kubectl(state, [
    '-n',
    'faultline-onboarding',
    'delete',
    'deployment',
    'faultline-log-test',
    '--ignore-not-found=true',
  ]);
  console.log('Removed only the temporary onboarding test Deployment.');
}

function uninstall() {
  const state = loadState();
  kubectl(
    state,
    ['delete', '-k', 'deploy/kubernetes', '--ignore-not-found=true'],
    {
      timeout: 120_000,
    },
  );
  console.log(
    'Faultline collector resources and the exclusively-owned faultline-system namespace were removed. BookNest was not changed.',
  );
}

(async () => {
  if (command === 'add') register();
  else if (command === 'install') await install();
  else if (command === 'verify') await verify();
  else if (command === 'onboard') {
    register();
    await install();
    await verify();
  } else if (command === 'cleanup') cleanup();
  else if (command === 'uninstall') uninstall();
  else
    throw new Error(
      'Usage: cluster.cjs <add|install|verify|onboard|cleanup|uninstall>',
    );
})().catch((error) => {
  console.error(`Onboarding failed: ${error.message}`);
  process.exitCode = 1;
});
