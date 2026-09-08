const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { rootCertificates } = require('node:tls');
const serviceAccount = mkdtempSync(
  join(tmpdir(), 'faultline-collector-validation-'),
);
writeFileSync(join(serviceAccount, 'ca.crt'), rootCertificates[0]);
writeFileSync(join(serviceAccount, 'token'), 'config-validation');
writeFileSync(join(serviceAccount, 'namespace'), 'config-validation');
try {
  for (const kind of ['logs', 'events']) {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-e',
        'FAULTLINE_CLUSTER_ID=config-validation',
        '-e',
        'FAULTLINE_AGENT_TOKEN=config-validation',
        '-e',
        'FAULTLINE_LOGS_ENDPOINT=http://127.0.0.1:3001/v1/otlp/logs',
        '-e',
        'KUBE_NODE_NAME=config-validation',
        '-e',
        'KUBE_NODE_IP=127.0.0.1',
        '-e',
        'KUBELET_INSECURE_SKIP_VERIFY=false',
        '-e',
        'FAULTLINE_METRICS_ENDPOINT=http://127.0.0.1:3001/v1/otlp/metrics',
        '--mount',
        'type=bind,source=' +
          serviceAccount +
          ',target=/var/run/secrets/kubernetes.io/serviceaccount,readonly',
        '-e',
        'KUBERNETES_SERVICE_HOST=127.0.0.1',
        '-e',
        'KUBERNETES_SERVICE_PORT=443',
        '--mount',
        `type=bind,source=${resolve(__dirname, '../deploy/kubernetes', `collector-${kind}.yaml`)},target=/etc/otelcol/config.yaml,readonly`,
        'otel/opentelemetry-collector-contrib:0.147.0',
        'validate',
        '--config=/etc/otelcol/config.yaml',
      ],
      { stdio: 'inherit', timeout: 180000 },
    );
    if (result.error || result.status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
} finally {
  // mkdtempSync creates this exact task-owned directory under the OS temp directory.
  rmSync(serviceAccount, { recursive: true, force: true });
}
