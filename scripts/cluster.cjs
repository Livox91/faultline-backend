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
const { Client } = require('pg');
const { createClient } = require('redis');
const { createInterface } = require('node:readline/promises');

const onboardingNamespace = 'faultline-onboarding';

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const verbose = Boolean(args.verbose);
const kubectl = (state, values, options = {}) => {
  const commandArgs = kubeArgs(state, ...values);
  if (verbose) console.log(`[debug] kubectl ${commandArgs.join(' ')}`);
  try {
    const output = run('kubectl', commandArgs, options);
    if (verbose && output) console.log(output);
    return output;
  } catch (error) {
    if (verbose && error.detail) console.error(error.detail);
    if (!verbose && error.detail && error.message.includes(error.detail)) {
      const friendly = new Error(
        options.message ||
          'A Kubernetes operation failed. Run again with --verbose for technical details.',
      );
      friendly.detail = error.detail;
      throw friendly;
    }
    throw error;
  }
};

const success = (message) => console.log(`\u2713 ${message}`);

function environmentFor(context) {
  if (context.startsWith('kind-')) return 'kind';
  if (context.startsWith('minikube')) return 'minikube';
  return 'external';
}

function inferredEndpoint(context) {
  const environment = environmentFor(context || '');
  if (environment === 'kind') return 'http://host.docker.internal:3001';
  if (environment === 'minikube') return 'http://host.minikube.internal:3001';
  return undefined;
}

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(
      'That address is not a valid URL. Include http:// or https:// and the port, for example http://192.168.1.50:3001.',
    );
  }
  if (!['http:', 'https:'].includes(endpoint.protocol))
    throw new Error(
      'The Faultline address must start with http:// or https://.',
    );
  if (['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname))
    throw new Error(
      'Kubernetes cannot use localhost to reach Faultline because localhost points back to the pod. Use an address reachable from inside the cluster.',
    );
  return endpoint.toString().replace(/\/$/, '');
}

function detectKubernetes(execute = run) {
  try {
    execute('kubectl', ['version', '--client'], {
      timeout: 10_000,
      message: 'kubectl is not installed or is not available on PATH.',
    });
  } catch (error) {
    throw new Error(
      'kubectl is not installed. Install kubectl, configure it for your cluster, and run this command again.',
    );
  }
  let current;
  try {
    current =
      args.context ||
      execute('kubectl', ['config', 'current-context'], {
        timeout: 10_000,
        message: 'No current Kubernetes context exists.',
      });
  } catch {
    throw new Error(
      'No Kubernetes cluster is selected. Configure kubectl for your cluster, then run this command again.',
    );
  }
  if (!current)
    throw new Error(
      'No Kubernetes cluster is selected. Configure kubectl for your cluster, then run this command again.',
    );
  let nodes;
  try {
    nodes = JSON.parse(
      execute(
        'kubectl',
        kubeArgs({ context: current }, 'get', 'nodes', '-o', 'json'),
        {
          timeout: 15_000,
          message: `Kubernetes context ${current} is unreachable.`,
        },
      ),
    ).items;
  } catch (error) {
    throw new Error(
      `Kubernetes cluster ${current} cannot be reached. Make sure the cluster is running and that kubectl can connect to it.`,
    );
  }
  const ready = nodes.filter((node) =>
    node.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  ).length;
  if (!nodes.length || !ready)
    throw new Error(
      `Kubernetes cluster ${current} responded, but none of its ${nodes.length} nodes are Ready. Wait for the cluster to finish starting and try again.`,
    );
  return {
    context: current,
    nodes: nodes.length,
    ready,
    environment: environmentFor(current),
  };
}

function registrationDefaults(context, prior = {}) {
  const sameCluster = prior.context === context;
  const clusterId =
    sameCluster && prior.clusterId
      ? prior.clusterId
      : inferredClusterId(context);
  return {
    clusterId,
    clusterName:
      sameCluster && prior.clusterName ? prior.clusterName : clusterId,
    ingestionEndpoint: sameCluster ? prior.ingestionEndpoint : undefined,
  };
}

function installedClusterConfiguration(context) {
  try {
    const configMap = JSON.parse(
      kubectl(
        { context },
        [
          '-n',
          'faultline-system',
          'get',
          'configmap/faultline-connection',
          '-o',
          'json',
        ],
        { message: 'Existing Faultline configuration could not be read.' },
      ),
    );
    if (!configMap.data?.['cluster-id']) return {};
    return {
      context,
      clusterId: configMap.data['cluster-id'],
      clusterName:
        configMap.data['cluster-name'] || configMap.data['cluster-id'],
      ingestionEndpoint: configMap.data['logs-endpoint']?.replace(
        /\/v1\/otlp\/logs\/?$/,
        '',
      ),
    };
  } catch {
    return {};
  }
}

async function answer(rl, question, defaultValue) {
  if (!rl) return defaultValue;
  const value = (await rl.question(question)).trim();
  return value || defaultValue;
}

async function confirm(rl, question) {
  if (args.yes) return true;
  if (!rl)
    throw new Error(
      'Confirmation is required. Run this command in a terminal, or pass --yes for an unattended installation.',
    );
  return /^(y|yes)$/i.test(await answer(rl, `${question} [y/N] `, 'no'));
}

function inferredClusterId(context) {
  const value = context.startsWith('kind-') ? context.slice(5) : context;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(`Cannot infer a cluster ID from ${context}`);
  return normalized;
}

async function persistCluster(state) {
  const api = parseEnv(resolve(root, 'apps/api/.env'));
  if (!api.DATABASE_URL)
    throw new Error('Missing DATABASE_URL. Run: npm run setup');
  const client = new Client({
    connectionString: api.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO clusters
         (id, name, kubernetes_context, workload_namespace, workload_selector)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name,
         kubernetes_context=EXCLUDED.kubernetes_context,
         workload_namespace=EXCLUDED.workload_namespace,
         workload_selector=EXCLUDED.workload_selector,
         updated_at=now()`,
      [
        state.clusterId,
        state.clusterName,
        state.context,
        state.workloadNamespace,
        state.workloadLabel,
      ],
    );
  } catch (error) {
    const failure = new Error(
      `Faultline could not register cluster ${state.clusterId}. Make sure Faultline is running, then try again.`,
    );
    failure.detail = error.message;
    throw failure;
  } finally {
    await client.end().catch(() => {});
  }
}

function clickhouseConfig() {
  const storage = parseEnv(resolve(root, 'apps/storage/.env'));
  if (!storage.CLICKHOUSE_URL)
    throw new Error('Missing CLICKHOUSE_URL. Run: npm run setup');
  const database = storage.CLICKHOUSE_DATABASE || 'faultline';
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(database))
    throw new Error('Invalid CLICKHOUSE_DATABASE');
  return {
    url: storage.CLICKHOUSE_URL,
    database,
    username: storage.CLICKHOUSE_USERNAME || 'default',
    password: storage.CLICKHOUSE_PASSWORD || '',
  };
}

async function clickhouseQuery(config, query, parameters = {}) {
  const url = new URL(config.url);
  url.searchParams.set('query', query);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(`param_${name}`, value);
  const authorization = Buffer.from(
    `${config.username}:${config.password}`,
  ).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${authorization}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`ClickHouse query failed with HTTP ${response.status}`);
  return body;
}

async function findOnboardingLog(clusterId) {
  const config = clickhouseConfig();
  const rows = await clickhouseQuery(
    config,
    `SELECT event_timestamp, pod, message
       FROM ${config.database}.telemetry_logs
      WHERE cluster_id = {cluster:String}
        AND namespace = {namespace:String}
        AND event_timestamp >= now() - INTERVAL 10 MINUTE
        AND position(message, {marker:String}) > 0
      ORDER BY event_timestamp DESC
      LIMIT 1
      FORMAT JSONEachRow`,
    {
      cluster: clusterId,
      namespace: onboardingNamespace,
      marker: 'FAULTLINE_ONBOARDING_TEST',
    },
  );
  const first = rows.split(/\r?\n/).find(Boolean);
  return first ? JSON.parse(first) : undefined;
}

async function onboardingEventIds(clusterId) {
  const config = clickhouseConfig();
  const ids = new Set();
  for (const table of [
    'telemetry_logs',
    'telemetry_metrics',
    'telemetry_kubernetes_events',
  ]) {
    const rows = await clickhouseQuery(
      config,
      `SELECT event_id FROM ${config.database}.${table} WHERE cluster_id = {cluster:String} AND namespace = {namespace:String} FORMAT JSONEachRow`,
      { cluster: clusterId, namespace: onboardingNamespace },
    );
    for (const line of rows.split(/\r?\n/).filter(Boolean))
      ids.add(JSON.parse(line).event_id);
  }
  return { config, ids };
}

function containsOnboardingState(value) {
  return JSON.stringify(value).includes(onboardingNamespace);
}

async function cleanupRedis(eventIds) {
  const processor = parseEnv(resolve(root, 'apps/processor/.env'));
  if (!processor.REDIS_URL)
    throw new Error('Missing REDIS_URL. Run: npm run setup');
  const redis = createClient({ url: processor.REDIS_URL });
  redis.on('error', () => {});
  await redis.connect();
  try {
    const stateDefinitions = [
      {
        key: 'faultline:rules:state:v1',
        names: ['evidence', 'conditions', 'active', 'restarts', 'watermarks'],
      },
      {
        key: 'faultline:statistical:state:v1',
        names: ['windows', 'signals'],
      },
    ];
    const filterScript = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local state = cjson.decode(raw)
      local names = cjson.decode(ARGV[2])
      local ids = cjson.decode(ARGV[3])
      local id_set = {}
      for _, id in ipairs(ids) do id_set[id] = true end
      local removed = 0
      for _, name in ipairs(names) do
        local retained = {}
        for _, item in ipairs(state[name] or {}) do
          if not string.find(cjson.encode(item), ARGV[1], 1, true) then
            table.insert(retained, item)
          else
            removed = removed + 1
          end
        end
        state[name] = retained
      end
      local seen = {}
      for _, item in ipairs(state.seenIds or {}) do
        if not id_set[item[1]] then table.insert(seen, item) end
      end
      state.seenIds = seen
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl > 0 then
        redis.call('SET', KEYS[1], cjson.encode(state), 'PX', ttl)
      else
        redis.call('SET', KEYS[1], cjson.encode(state))
      end
      return removed
    `;
    for (const definition of stateDefinitions)
      await redis.eval(filterScript, {
        keys: [definition.key],
        arguments: [
          onboardingNamespace,
          JSON.stringify(definition.names),
          JSON.stringify([...eventIds]),
        ],
      });

    const resourceKeys = [];
    for await (const batch of redis.scanIterator({
      MATCH: 'faultline:resource:*',
      COUNT: 100,
    })) {
      for (const key of batch) {
        const raw = await redis.get(key);
        if (raw && containsOnboardingState(JSON.parse(raw)))
          resourceKeys.push(key);
      }
    }
    const processedKeys = [...eventIds].map(
      (id) => `faultline:processed:${id}`,
    );
    const keys = [...resourceKeys, ...processedKeys];
    if (keys.length) await redis.del(keys);
  } finally {
    await redis.quit().catch(() => {});
  }
}

async function cleanupPersistedOnboardingData(clusterId) {
  const { config, ids } = await onboardingEventIds(clusterId);
  await cleanupRedis(ids);

  const api = parseEnv(resolve(root, 'apps/api/.env'));
  if (!api.DATABASE_URL)
    throw new Error('Missing DATABASE_URL. Run: npm run setup');
  const client = new Client({
    connectionString: api.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM incidents WHERE cluster_id = $1 AND namespace = $2',
      [clusterId, onboardingNamespace],
    );
    await client.query(
      'DELETE FROM metric_baselines WHERE cluster_id = $1 AND namespace = $2',
      [clusterId, onboardingNamespace],
    );
    await client.query(
      'DELETE FROM log_pattern_aggregates WHERE cluster_id = $1 AND namespace = $2',
      [clusterId, onboardingNamespace],
    );
    if (ids.size)
      await client.query(
        'DELETE FROM log_classifications WHERE event_id = ANY($1::text[])',
        [[...ids]],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }

  for (const table of [
    'telemetry_logs',
    'telemetry_metrics',
    'telemetry_kubernetes_events',
  ])
    await clickhouseQuery(
      config,
      `ALTER TABLE ${config.database}.${table} DELETE WHERE cluster_id = {cluster:String} AND namespace = {namespace:String} SETTINGS mutations_sync = 1`,
      { cluster: clusterId, namespace: onboardingNamespace },
    );
}

async function register(options = {}) {
  const detected = options.detected || detectKubernetes();
  const current = detected.context;
  const localState = (() => {
    try {
      return loadState();
    } catch {
      return {};
    }
  })();
  const installed = installedClusterConfiguration(current);
  const prior =
    localState.context === current
      ? localState
      : installed.context === current
        ? installed
        : {};
  const ingestion = parseEnv(resolve(root, 'apps/ingestion/.env'));
  const token = ingestion.FAULTLINE_DEV_AGENT_TOKEN;
  if (!token)
    throw new Error(
      'Faultline credentials are not configured. Run npm run setup, start Faultline, and try again.',
    );
  const defaults = registrationDefaults(current, prior);
  const clusterName =
    args.name ||
    (options.guided
      ? await answer(
          options.rl,
          `\nChoose a name for this cluster:\n\n> `,
          defaults.clusterName,
        )
      : defaults.clusterName);
  const state = {
    version: 1,
    clusterId: args.id || defaults.clusterId,
    clusterName,
    context: current,
    ingestionEndpoint:
      args.endpoint || defaults.ingestionEndpoint || inferredEndpoint(current),
    token,
    workloadNamespace:
      args['workload-namespace'] || prior.workloadNamespace || 'default',
    workloadLabel:
      args['workload-label'] || prior.workloadLabel || 'app=booknest-backend',
    insecureKubelet:
      Boolean(args['insecure-kubelet']) ||
      Boolean(prior.insecureKubelet) ||
      /^(kind-|minikube)/.test(current),
  };
  if (state.ingestionEndpoint)
    state.ingestionEndpoint = validateEndpoint(state.ingestionEndpoint);
  if (!options.guided && !state.ingestionEndpoint)
    throw new Error(
      'Faultline cannot infer an ingestion address for this cluster. Pass a URL reachable from Kubernetes with --endpoint.',
    );
  if (!options.deferPersist) {
    await persistCluster(state);
    saveState(state);
    if (!options.guided) {
      console.log(`Registered ${state.clusterName} (${state.clusterId}).`);
      console.log(`kubectl context: ${state.context}`);
      console.log(`Ingestion endpoint: ${state.ingestionEndpoint}`);
      console.log('The agent token was stored locally and was not printed.');
    }
  }
  return state;
}

async function connectivity(state, options = {}) {
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
        if (!options.quiet) success(`Kubernetes can reach ${endpoint}`);
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
    const failure = new Error(
      `Kubernetes cannot reach Faultline at ${publicEndpoint(state.ingestionEndpoint)}.\n\nPossible causes:\n\n- Faultline ingestion is not running\n- port 3001 is blocked\n- the hostname is unavailable inside Kubernetes\n- the configured IP or hostname is incorrect`,
    );
    failure.detail = error.detail || error.message;
    throw failure;
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

async function install(state = loadState(), options = {}) {
  if (!options.skipConnectivity) await connectivity(state);
  applyJson(state, {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'faultline-system' },
  });
  if (options.guided) success('Faultline namespace ready');
  applyJson(state, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'faultline-agent', namespace: 'faultline-system' },
    type: 'Opaque',
    stringData: { token: state.token },
  });
  if (options.guided) success('Agent credentials created');
  const base = publicEndpoint(state.ingestionEndpoint);
  applyJson(state, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'faultline-connection', namespace: 'faultline-system' },
    data: {
      'cluster-id': state.clusterId,
      'cluster-name': state.clusterName,
      'logs-endpoint': `${base}/v1/otlp/logs`,
      'metrics-endpoint': `${base}/v1/otlp/metrics`,
    },
  });
  if (options.guided) success('Collector configuration created');
  kubectl(state, ['apply', '-k', 'deploy/kubernetes'], {
    timeout: 120_000,
    message:
      'Collector installation failed. Verify kubectl permissions for namespaces, RBAC, DaemonSets and Deployments.',
  });
  if (options.guided) success('Permissions configured');
  if (state.insecureKubelet)
    kubectl(state, [
      '-n',
      'faultline-system',
      'set',
      'env',
      'daemonset/faultline-collector-logs',
      'KUBELET_INSECURE_SKIP_VERIFY=true',
    ]);
  // Secret and ConfigMap value changes do not alter the pod template by themselves.
  // Restart both collectors explicitly so verification cannot observe pods still
  // exporting with the previous cluster identity or token.
  kubectl(state, [
    '-n',
    'faultline-system',
    'rollout',
    'restart',
    'daemonset/faultline-collector-logs',
  ]);
  kubectl(state, [
    '-n',
    'faultline-system',
    'rollout',
    'restart',
    'deployment/faultline-collector-events',
  ]);
  if (options.guided) console.log('\nWaiting for Faultline Collector...\n');
  try {
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
  } catch (error) {
    throw collectorStartupError(state, error);
  }
  const status = await collectorStatus(state);
  if (options.guided) {
    success(
      `Collector running on ${status.ready}/${status.desired} node${status.desired === 1 ? '' : 's'}`,
    );
    success('Collector installed');
  } else console.log('Faultline collectors installed and rolled out.');
  return status;
}

function podFailureReason(pods) {
  for (const pod of pods) {
    for (const status of pod.status?.containerStatuses || []) {
      if (status.state?.waiting?.reason) return status.state.waiting.reason;
      if ((status.restartCount || 0) > 2) return 'CrashLoopBackOff';
      if (status.state?.terminated?.reason)
        return status.state.terminated.reason;
    }
  }
  return undefined;
}

function collectorStartupError(state, cause) {
  let reason = 'collector pods did not become ready before the timeout';
  try {
    const pods = JSON.parse(
      kubectl(state, [
        '-n',
        'faultline-system',
        'get',
        'pods',
        '-l',
        'app in (faultline-collector-logs,faultline-collector-events)',
        '-o',
        'json',
      ]),
    ).items;
    reason = podFailureReason(pods) || reason;
  } catch {}
  const error = new Error(
    `Collector failed to start.\n\nReason:\n${reason}\n\nTry:\nkubectl get pods -n faultline-system\nkubectl describe pod <pod> -n faultline-system`,
  );
  error.detail = cause.detail || cause.message;
  return error;
}

async function collectorStatus(state) {
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
  const pods = JSON.parse(
    kubectl(state, [
      '-n',
      'faultline-system',
      'get',
      'pods',
      '-l',
      'app in (faultline-collector-logs,faultline-collector-events)',
      '-o',
      'json',
    ]),
  ).items;
  const unhealthyReason = podFailureReason(pods);
  if (unhealthyReason)
    throw new Error(
      `Collector is not healthy (${unhealthyReason}). Inspect: kubectl get pods -n faultline-system`,
    );
  const recentExportFailures = (since) =>
    kubectl(state, [
      '-n',
      'faultline-system',
      'logs',
      'daemonset/faultline-collector-logs',
      '--all-containers=true',
      `--since=${since}`,
      '--prefix=true',
    ])
      .split(/\r?\n/)
      .filter((line) =>
        /export.*failed|sending queue.*full|unauthorized/i.test(line),
      );
  let exportFailures = recentExportFailures('30s');
  if (exportFailures.length >= 3) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    exportFailures = recentExportFailures('5s');
  }
  if (exportFailures.length >= 3)
    throw new Error(
      `Collector is repeatedly failing exports (${exportFailures.length} recent errors). Check the endpoint and token, then restart the collector.`,
    );
  return { desired, ready, eventReady };
}

async function verify(state = loadState(), options = {}) {
  await Promise.all(
    [3000, 3001, 3002, 3003].map((port) =>
      requestJson(`http://127.0.0.1:${port}/health/ready`, { timeout: 3_000 }),
    ),
  ).catch(() => {
    throw new Error(
      'Faultline services are not ready. Start them with: npm run faultline:start',
    );
  });
  if (!options.skipConnectivity) await connectivity(state);
  const collector = await collectorStatus(state);
  if (options.guided) {
    console.log('\nTesting log collection...\n');
  }
  kubectl(state, ['apply', '-f', 'deploy/kubernetes/onboarding-test.yaml'], {
    timeout: 30_000,
  });
  if (options.guided) success('Test pod created');
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
  while (Date.now() < deadline && !received) {
    try {
      // The telemetry API is intentionally authenticated. Onboarding is a local
      // operator command with ClickHouse credentials already configured, so verify
      // persistence directly instead of turning an expected API 401 into a false
      // "log did not reach ClickHouse" timeout.
      received = await findOnboardingLog(state.clusterId);
    } catch {}
    if (!received)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  }
  if (!received)
    throw new Error(
      'The onboarding log did not reach ClickHouse. Inspect collector logs, ingestion health, NATS, and storage readiness.',
    );

  if (options.guided) {
    success('Test log emitted');
    success('Faultline received the log');
    return { collector, received };
  }

  console.log('\nFAULTLINE ONBOARDING COMPLETE\n');
  console.log(`Cluster: ${state.clusterName} (${state.clusterId})`);
  console.log(`Collector: Healthy (${collector.ready}/${collector.desired})`);
  console.log('Faultline ingestion: Healthy');
  console.log('Processor: Healthy');
  console.log('Telemetry storage: Healthy');
  console.log(`Onboarding probe: Received from ${received.pod}`);
  console.log('Kubernetes → Faultline: CONNECTED');
  return { collector, received };
}

function cleanupTestWorkload(state, options = {}) {
  kubectl(state, [
    'delete',
    'namespace',
    onboardingNamespace,
    '--ignore-not-found=true',
    '--wait=true',
    '--timeout=90s',
  ]);
  if (options.guided) success('Test pod removed');
}

async function cleanup() {
  const state = loadState();
  kubectl(state, [
    '-n',
    'faultline-onboarding',
    'delete',
    'deployment',
    'faultline-log-test',
    '--ignore-not-found=true',
  ]);
  try {
    kubectl(state, [
      '-n',
      onboardingNamespace,
      'wait',
      '--for=delete',
      'pod',
      '-l',
      'app.kubernetes.io/name=faultline-log-test',
      '--timeout=60s',
    ]);
  } catch {}
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  run('npm', ['run', 'faultline:stop'], {
    inherit: true,
    timeout: 120_000,
  });
  try {
    run('npm', ['run', 'infra:up'], {
      inherit: true,
      timeout: 180_000,
    });
    await cleanupPersistedOnboardingData(state.clusterId);
  } finally {
    run('npm', ['run', 'faultline:start'], {
      inherit: true,
      timeout: 300_000,
    });
  }
  cleanupTestWorkload(state);
  console.log(
    'Removed temporary onboarding test resources and persisted data.',
  );
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

async function chooseReachableEndpoint(state, rl) {
  let candidate = state.ingestionEndpoint;
  let automatic = Boolean(candidate);
  while (true) {
    if (!candidate) {
      console.log(
        '\nKubernetes runs in a different network environment.\nIt needs an address that can reach Faultline from inside the cluster.\n',
      );
      candidate = await answer(
        rl,
        'What address can your Kubernetes cluster use\nto reach Faultline ingestion?\n\nExample:\nhttp://192.168.1.50:3001\n\n> ',
      );
      if (!candidate)
        throw new Error(
          'A Faultline ingestion address is required. Pass it with --endpoint when running unattended.',
        );
    }
    try {
      state.ingestionEndpoint = validateEndpoint(candidate);
      await connectivity(state, { quiet: true });
      return;
    } catch (error) {
      if (!rl || args.endpoint) throw error;
      if (automatic)
        console.log(
          `\nThe automatically selected address (${candidate}) is not reachable from this cluster.`,
        );
      else console.log(`\n${error.message}`);
      console.log(
        '\nKubernetes runs in a different network environment.\nEnter an address it can reach from inside the cluster.\n',
      );
      candidate = await answer(rl, 'Example:\nhttp://192.168.1.50:3001\n\n> ');
      automatic = false;
    }
  }
}

async function guidedOnboard() {
  const rl =
    process.stdin.isTTY && process.stdout.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
  let state;
  let testStarted = false;
  try {
    console.log('\nFaultline Kubernetes Setup\n');
    const detected = detectKubernetes();
    console.log('Kubernetes detected\n');
    console.log(`Cluster context:\n${detected.context}\n`);
    console.log(`Nodes:\n${detected.ready} Ready\n`);
    success('Kubernetes is reachable');
    if (detected.environment === 'kind')
      console.log(
        '\nLocal kind cluster detected.\nFaultline will configure local development networking.',
      );

    console.log(
      '\nFaultline will install a lightweight collector\ninto this Kubernetes cluster.\n\nThe collector reads container logs and sends\nthem to your Faultline installation.\n\nIt does not modify your applications.\n',
    );
    if (!(await confirm(rl, 'Continue?'))) {
      console.log('\nSetup cancelled. No changes were made.');
      return;
    }

    state = await register({ detected, rl, guided: true, deferPersist: true });
    await requestJson('http://127.0.0.1:3001/health/ready', {
      timeout: 3_000,
    }).catch(() => {
      throw new Error(
        'Faultline ingestion is not running. Start Faultline with npm run faultline:start, then run onboarding again.',
      );
    });
    console.log('\nTesting connection to Faultline...\n');
    await chooseReachableEndpoint(state, rl);
    success('Faultline ingestion reachable');

    console.log('\nConnecting Kubernetes to Faultline...\n');
    await persistCluster(state);
    saveState(state);
    success('Cluster registered');
    const collector = await install(state, {
      guided: true,
      skipConnectivity: true,
    });

    console.log('\nTesting connection to Faultline...\n');
    await connectivity(state, { quiet: true });
    success('Faultline ingestion reachable');

    testStarted = true;
    await verify(state, { guided: true, skipConnectivity: true });
    cleanupTestWorkload(state, { guided: true });
    testStarted = false;

    console.log('\n----------------------------------------\n');
    console.log('Faultline Kubernetes Setup Complete\n');
    console.log(`Cluster:\n${state.clusterName}\n`);
    console.log('Kubernetes:\nConnected\n');
    console.log(
      `Faultline Collector:\nRunning (${collector.ready}/${collector.desired} nodes)\n`,
    );
    console.log('Faultline Ingestion:\nReachable\n');
    console.log('Log Collection:\nWorking\n');
    console.log('----------------------------------------\n');
    console.log('Faultline is now monitoring this cluster.\n');
    console.log('Check collector:\n\nkubectl get pods -n faultline-system\n');
    console.log(
      'Remove Faultline from this cluster:\n\nnpm run cluster:uninstall',
    );
  } finally {
    if (testStarted && state) {
      try {
        cleanupTestWorkload(state, { guided: true });
      } catch {}
    }
    rl?.close();
  }
}

async function main() {
  if (command === 'add') await register();
  else if (command === 'install') await install();
  else if (command === 'verify') {
    try {
      await verify();
    } finally {
      await cleanup();
    }
  } else if (command === 'onboard') {
    await guidedOnboard();
  } else if (command === 'cleanup') await cleanup();
  else if (command === 'uninstall') uninstall();
  else
    throw new Error(
      'Usage: cluster.cjs <add|install|verify|onboard|cleanup|uninstall>',
    );
}

if (require.main === module)
  main().catch((error) => {
    console.error(`\nSetup could not be completed.\n\n${error.message}`);
    if (verbose && error.detail)
      console.error(`\nDebug details:\n${error.detail}`);
    console.error(
      '\nYou can safely run npm run cluster:onboard again after fixing this.',
    );
    process.exitCode = 1;
  });

module.exports = {
  environmentFor,
  inferredEndpoint,
  inferredClusterId,
  validateEndpoint,
  detectKubernetes,
  registrationDefaults,
  podFailureReason,
};
