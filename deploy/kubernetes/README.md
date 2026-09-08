# Kubernetes collection

For CPU/memory metrics, workload state, updated RBAC and the bounded local demo,
see [Metrics and workload state](METRICS.md). The same two Collector deployments now
export metrics and structured state snapshots as well as logs/events.

Container stdout/stderr → Collector DaemonSet → OTLP/HTTP JSON → ingestion's
isolated `/v1/otlp/logs` adapter → shared `TelemetryEvent` → `telemetry.raw` → processor.
A single Collector Deployment watches Kubernetes Events and uses the same adapter.
The existing `/v1/telemetry/*` endpoints still work.

Collector Contrib is pinned to **0.147.0**. The [container parser](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.147.0/pkg/stanza/docs/operators/container.md)
handles CRI/containerd, CRI-O and Docker container log framing, including stdout/stderr
and partial records. File paths supply pod UID, namespace, pod and container identity.
Only `/var/log/pods` is mounted, read-only, on Linux nodes. Clusters with custom log
locations need matching mounts and include paths. The `faultline-system` namespace is
excluded to avoid collecting the collectors' and local Faultline's own output.

The [Kubernetes objects receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.147.0/receiver/k8sobjectsreceiver/README.md)
uses a cluster-wide core/v1 Event watch. A separate single replica with `Recreate`
avoids one duplicate stream per DaemonSet node and needs no leader-election writes.
Start it before the demo workload: this configuration observes new watch notifications,
not a historical snapshot. Event modifications may produce additional records as counts
increase. Events are best effort, not an audit trail.

## Local setup: kind

Prerequisites: Node.js 22+, npm, Docker with a running Linux engine, `kubectl` and
[kind](https://kind.sigs.k8s.io/docs/user/quick-start/). Commands below are PowerShell,
run from the repository's `faultline` directory. Use a dedicated local cluster.

```powershell
kind create cluster --name faultline --config deploy/kubernetes/local/kind.yaml --wait 120s
kubectl config use-context kind-faultline
npm ci
npm test
npm run validate:collector
docker build -f Dockerfile.dev -t faultline:dev .
kind load docker-image faultline:dev --name faultline
kubectl apply -f deploy/kubernetes/namespace.yaml
```

If Docker's containerd image store makes `kind load` fail with `content digest ... not
found`, import only the platform your nodes use. This Linux/AMD64 fallback was used
successfully with Docker Desktop 27.5.1 and kind 0.27.0:

```powershell
New-Item -ItemType Directory -Force .local | Out-Null
docker pull otel/opentelemetry-collector-contrib:0.147.0
docker save faultline:dev otel/opentelemetry-collector-contrib:0.147.0 -o .local/faultline-images.tar
foreach ($clusterNode in @('faultline-control-plane', 'faultline-worker')) {
  docker cp .local/faultline-images.tar "${clusterNode}:/tmp/faultline-images.tar"
  docker exec $clusterNode ctr --namespace=k8s.io images import --platform linux/amd64 /tmp/faultline-images.tar
  docker exec $clusterNode rm /tmp/faultline-images.tar
}
```

For the cluster created during this workspace's verification, the default kubectl context
is `kind-faultline`. An additional kubeconfig is in `.local/kubeconfig`; select that copy with
`$env:KUBECONFIG = (Resolve-Path .local/kubeconfig).Path`. The downloaded kind executable
is `.local/kind.exe`. Both nodes run Kubernetes 1.32.2; verification used Docker's bundled
kubectl 1.31.4. `.local` is ignored by Git and contains cluster credentials and local tools.

Create a random development token without putting it in a manifest or command argument.
The local Faultline Deployment and collectors reference the same Secret. The API access
used by these deployment commands belongs to you, not the collector service accounts.

```powershell
$tokenBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($tokenBytes)
$rng.Dispose()
$env:FAULTLINE_DEV_AGENT_TOKEN = [Convert]::ToBase64String($tokenBytes)
$secret = @{ apiVersion = 'v1'; kind = 'Secret'; metadata = @{ name = 'faultline-agent'; namespace = 'faultline-system' }; type = 'Opaque'; stringData = @{ token = $env:FAULTLINE_DEV_AGENT_TOKEN } }
$secret | ConvertTo-Json -Depth 5 -Compress | kubectl apply -f -
kubectl -n faultline-system create configmap faultline-connection --from-literal=cluster-id=development-cluster --from-literal=logs-endpoint=http://faultline-ingestion.faultline-system.svc.cluster.local:3001/v1/otlp/logs --from-literal=metrics-endpoint=http://faultline-ingestion.faultline-system.svc.cluster.local:3001/v1/otlp/metrics --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deploy/kubernetes/local/faultline.yaml
kubectl -n faultline-system rollout status deployment/faultline-dev --timeout=120s
kubectl apply -k deploy/kubernetes
# Local kind only; base manifests require a trusted kubelet certificate.
kubectl -n faultline-system set env daemonset/faultline-collector-logs KUBELET_INSECURE_SKIP_VERIFY=true
kubectl -n faultline-system rollout status daemonset/faultline-collector-logs --timeout=180s
kubectl -n faultline-system rollout status deployment/faultline-collector-events --timeout=180s
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl create namespace faultline-demo --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deploy/kubernetes/local/workload-metrics.yaml
kubectl apply -f deploy/kubernetes/local/workload.yaml
kubectl -n faultline-demo rollout status deployment/telemetry-demo --timeout=120s
npm run verify:kubernetes
```

The local Faultline container runs ingestion and processor together, with the existing
process-local queue. It has no Kubernetes API token and exposes only an internal Service.
This is development wiring, not a distributed or production Faultline deployment.
If your registry downloads time out, resolve registry connectivity and rerun the build
and rollout commands; a pending/image-pull pod cannot demonstrate collection.

`verify:kubernetes` reads the processor's last five minutes of logs and requires both
stdout and stderr with cluster, namespace, pod, container, node, pod UID, container ID
and original demo message, plus a Kubernetes Event for the demo pod. It exits nonzero
after 90 seconds if any evidence is missing. Set `FAULTLINE_KUBE_CONTEXT`,
`FAULTLINE_CLUSTER_ID` or `KUBECONFIG` to override its defaults.
If the demo predates the event collector, restart it before rerunning verification:

```powershell
kubectl -n faultline-demo rollout restart deployment/telemetry-demo
kubectl -n faultline-system logs deployment/faultline-dev --since=5m
```

The demo prints normal messages to stdout and simulated ERROR messages to stderr every
five seconds. Plain text has no explicit OTLP severity, so its level is `unknown` and
its stream is retained; stderr alone is not treated as an error classification.
To request exactly one container restart:

```powershell
kubectl -n faultline-demo exec deployment/telemetry-demo -- touch /control/restart
```

## Running Faultline on the host instead

You can use the existing host launcher instead of `local/faultline.yaml`:

```powershell
$env:NODE_ENV = 'development'
$env:APP_VERSION = 'kubernetes-dev'
$env:HOST = '0.0.0.0'
$env:FAULTLINE_LOG_DEMO_MESSAGES = 'true'
# Set FAULTLINE_DEV_AGENT_TOKEN to the same value provisioned in faultline-agent.
npm run dev:pipeline
```

On Docker Desktop, change `faultline-connection`'s `logs-endpoint` to
`http://host.docker.internal:3001/v1/otlp/logs`, then restart both collectors.
On Linux, use a host address routable from the kind nodes. Do not use `localhost`:
inside the collector that means the collector itself. Also update `metrics-endpoint` to the host URL ending in `/v1/otlp/metrics`. Host firewalls must allow the
local cluster to reach port 3001. For host mode, inspect host stdout rather than using
the verifier, which reads the in-cluster Faultline Deployment.

HTTP examples here are for the local development cluster. For a remote cluster, provide
a reachable HTTPS endpoint with a valid CA-trusted certificate; no TLS verification
bypass is configured. Development cluster authentication and the in-memory queue remain
the current Faultline limitations. No production authentication is introduced.

## Configuration and RBAC

| Configuration             | Source                                         | Purpose                                                |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `FAULTLINE_CLUSTER_ID`    | `faultline-connection` ConfigMap, `cluster-id` | Required outgoing cluster header and resource identity |
| `FAULTLINE_LOGS_ENDPOINT` | Same ConfigMap, `logs-endpoint`                | Complete URL including `/v1/otlp/logs`                 |
| `FAULTLINE_AGENT_TOKEN`   | `faultline-agent` Secret, `token`              | Required outgoing agent-token header                   |
| `KUBE_NODE_NAME`          | Downward API, `spec.nodeName`                  | Filter pod discovery to the DaemonSet's node           |

The ServiceAccount does not read the Secret API: Kubernetes injects the explicitly
referenced key into the container environment. Rotating the Secret or connection
ConfigMap requires restarting both collectors and, for token rotation, local Faultline.
Kustomize hashes the collector configuration ConfigMaps so changed collector settings
automatically trigger a rollout on reapplication.

| Account            | Resource          | Verbs            | Reason                                                               |
| ------------------ | ----------------- | ---------------- | -------------------------------------------------------------------- |
| `faultline-logs`   | core `pods`       | get, list, watch | Pod identity, owner references, container status and selected labels |
| `faultline-logs`   | core `namespaces` | get, list, watch | Namespace discovery used by the metadata processor                   |
| `faultline-events` | core `events`     | list, watch      | Initial resource version, watch updates and reconnect after expiry   |

The metrics extension additionally grants the DaemonSet `get nodes/stats` and read-only ReplicaSets, and grants
the event/cluster collector read-only nodes, namespaces, pods, deployments, replicasets,
daemonsets, statefulsets, jobs, cronjobs, HPAs, services, quotas and replication controllers.
There are no wildcard resources, Secret reads, write verbs, host networking,
privileged containers or host PID access.
Node names come from pod metadata and the Downward API. The log collector runs as UID 0
to read node log files, drops all Linux capabilities and uses a read-only root filesystem.
The event collector runs as non-root and has no host mounts. A DaemonSet toleration allows
collection on tainted Linux nodes, including the local control-plane node.

The [metadata processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.147.0/processor/k8sattributesprocessor/README.md)
associates records by pod UID. Deployment names now use ReplicaSet owner references
with read-only ReplicaSet access instead of guessing from the name suffix.
Other owner names remain optional. Only the pod labels
`app.kubernetes.io/name` and `app.kubernetes.io/component` are extracted; extend the
explicit allowlist for other non-sensitive labels rather than collecting every label.

## Translation boundary

`apps/ingestion/src/otlp` decodes the Collector's JSON transport and validates normalized
events with `packages/telemetry`. It does not introduce another domain model.

| Collector data                                              | Shared Faultline field                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Container log timestamp                                     | `timestamp`, retaining nanosecond precision                                                       |
| `observedTimeUnixNano`                                      | Timestamp fallback only when event time is absent; original values also retained in attributes    |
| Log body                                                    | `message` unchanged for strings, and `raw`; structured bodies use JSON text for message           |
| `log.iostream`                                              | `stream` (`stdout` or `stderr`)                                                                   |
| Severity number/text                                        | Existing `level`; unknown when absent                                                             |
| Kubernetes namespace/pod/container/node resource attributes | `namespace`, `pod`, `container`, `node`                                                           |
| Owner workload attributes                                   | `workload`                                                                                        |
| `service.name` or selected app-name label                   | `service`                                                                                         |
| Pod UID, container ID, selected labels and other attributes | Existing JSON `attributes`                                                                        |
| Kubernetes Event body or watch wrapper                      | `kind=kubernetes`, `reason`, `message`, `type`, `involvedObject`, `count`, original body in `raw` |

Core Events and `events.k8s.io/v1` body shapes are supported by the adapter, although
the collector deliberately watches only core Events to avoid duplicate API streams.
Event occurrence time comes from last occurrence, series time, event time, first
occurrence, creation time, then collector observation, in that order. For Pod events,
the involved resource supplies pod name/UID; events about other resource kinds do not
invent pod/container metadata. Ingestion adds `ingestedAt`; processor adds `processedAt`.

The [OTLP HTTP exporter](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.147.0/exporter/otlphttpexporter/README.md)
uses JSON, gzip and the configured headers. The adapter accepts at most 256 records
and 2 MiB of decompressed JSON per request (the ingestion JSON parser also applies this
byte bound to its existing REST endpoints). It supports this Collector's OTLP logs JSON
shape, not protobuf, gRPC or traces. Scalar metrics use the separate `/v1/otlp/metrics` endpoint. Authentication is shared with REST ingestion.

Successful queue acceptance returns HTTP 200 and `{}`, as required for an OTLP logs
response. Individual malformed records return a 200 `partialSuccess` count; valid
records continue. Invalid envelopes return 400, wrong media types 415, oversized bodies
413, invalid credentials 401, and queue unavailability 503. These follow the
[OTLP response/retry distinction](https://opentelemetry.io/docs/specs/otlp/).
No request bodies, tokens or validation values are echoed into error logs.

Processor logs include context, stream/severity and event reason. Message text remains
off by default: the local manifest enables `FAULTLINE_LOG_DEMO_MESSAGES=true`, which only
prints messages from `faultline-demo` while `NODE_ENV=development`. Do not place secrets
in demo logs. Other raw payloads and arbitrary attributes are not printed.

## Resilience and collector status

Both collectors use a 192 MiB memory limiter with 48 MiB spike allowance, a 256 MiB
container memory limit, batches of up to 32 records every two seconds, and a bounded
128-request in-memory export queue. Temporary delivery failures retry from one second
up to thirty seconds, for at most five minutes per batch. File reading retries downstream
backpressure for up to one minute. Workloads only write their ordinary container logs;
they do not contact or wait for Faultline.

Buffers and file offsets are not persisted. Long outages, collector restarts, exhausted
queues and rotated files can lose data. File collection starts at the end of existing
files; records arriving before discovery of a new file may be missed. The receiver/parser
limits log size to 16 KiB, so larger records may split. Exceptionally large metadata/batches
can exceed the ingestion byte bound and be rejected. These are development limits.
Retry after a partially published batch can duplicate already accepted events, and
IDs are regenerated on retry. There is no durable delivery or deduplication guarantee.

```powershell
kubectl -n faultline-system get pods -o wide
kubectl -n faultline-system logs daemonset/faultline-collector-logs --tail=30
kubectl -n faultline-system logs deployment/faultline-collector-events --tail=30
kubectl -n faultline-system port-forward daemonset/faultline-collector-logs 13133:13133 8888:8888
```

In another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:13133/
(Invoke-WebRequest http://127.0.0.1:8888/metrics).Content | Select-String 'otelcol_(receiver|exporter)_'
```

Inspect receiver accepted/refused log-record counters, exporter sent/send-failed counters
and exporter queue size/capacity. Repeat the port-forward for the event Deployment or
each DaemonSet pod; these are per-instance measurements. The health endpoint indicates
collector process health, not successful export. Ports are pod-local unless explicitly
forwarded; no metrics dashboard is deployed.

For an outage check, scale local Faultline down, let the demo run for thirty seconds,
inspect collector retry logs/queue metrics and confirm the demo is still running. Scale
Faultline back up and verify export resumes:

```powershell
kubectl -n faultline-system scale deployment/faultline-dev --replicas=0
kubectl -n faultline-demo get pods
# Wait about 30 seconds, inspect collector errors/queue metrics, then restore:
kubectl -n faultline-system scale deployment/faultline-dev --replicas=1
kubectl -n faultline-system rollout status deployment/faultline-dev
kubectl -n faultline-demo rollout restart deployment/telemetry-demo
npm run verify:kubernetes
```

## Uninstall

These names and namespaces belong only to this example. Remove them with:

```powershell
kubectl delete -f deploy/kubernetes/local/workload.yaml --ignore-not-found
kubectl delete -f deploy/kubernetes/local/faultline.yaml --ignore-not-found
kubectl delete -k deploy/kubernetes --ignore-not-found
# Optionally delete the entire dedicated local cluster:
kind delete cluster --name faultline
```

Deleting `faultline-system` also removes the connection ConfigMap and agent Secret.
Deleting the Kustomization removes both cluster-scoped roles and bindings.
