# Metrics and workload state

Faultline now accepts scalar metrics in batches and builds a current resource view.
The processor evaluates deterministic anomaly rules and correlates them into temporary
in-memory incidents. Alerts, durable databases, and durable queue infrastructure remain
unimplemented.

## Collection

Collector Contrib remains pinned to 0.147.0.

| Source                                                                                                                                  | Placement                             | Data                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [kubeletstats](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.147.0/receiver/kubeletstatsreceiver/README.md) | Existing log DaemonSet, once per node | Container/pod/node CPU and memory usage; pod/node network receive/transmit counters; filesystem metrics when kubelet supplies them                        |
| [k8s_cluster](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.147.0/receiver/k8sclusterreceiver/README.md)    | Existing single event Deployment      | CPU/memory requests and limits, container readiness/restarts, pod phase, Deployment desired/available replicas, node conditions                           |
| [k8sobjects](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.147.0/receiver/k8sobjectsreceiver/README.md)     | Same single Deployment                | Periodic pod/deployment status snapshots supplying actual pod readiness, container state and last termination reason, and Deployment unavailable replicas |

Usage, cluster metrics and state snapshots are sampled every 15 seconds; exporter
batches flush within two seconds. The snapshot pipeline removes spec and unused metadata
before export. It never exports pod environment variables. Snapshot normalization emits
selected structured `MetricEvent` records and does not retain entire Kubernetes objects.
The Collector uses the OTLP logs envelope for those structured snapshots as required by
the objects receiver; they become metrics, not plain text logs, inside Faultline.

Resource metadata enrichment includes pod UID and workload name. The metadata processor
reads ReplicaSet owner references to resolve Deployment names. Pod/container state
is keyed by cluster, namespace, pod UID (name fallback), and container name. Container
runtime IDs are intentionally not part of the key: restarts must update the same logical
container. Recreated pods with different UIDs cannot inherit old limits/restart counts.

Some metrics are unavailable on some runtimes/filesystems. Missing samples remain missing;
Faultline never fabricates zero usage. Network metrics are cumulative byte counters with
`direction` and `interface` attributes, not calculated rates.

## Canonical contracts

Names, unit aliases and categories are defined in `packages/telemetry`, shared by
both ingestion transports and the processor. Existing fields remain `id`, `timestamp`,
`ingestedAt`, `clusterId`, optional Kubernetes context, `name`, `value`, `unit`,
`metricType`, `attributes`, and `raw`. This preserves the existing contract instead of
introducing alternate `eventId`/`metricName` fields.

| Canonical name                                               | Category      | Value                                                  |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------ |
| `k8s.container.cpu.usage`                                    | usage         | CPU cores                                              |
| `k8s.container.memory.usage`                                 | usage         | bytes (`By`)                                           |
| `k8s.container.cpu.limit`, `k8s.container.cpu.request`       | configuration | CPU cores                                              |
| `k8s.container.memory.limit`, `k8s.container.memory.request` | configuration | bytes                                                  |
| `k8s.container.restart_count`                                | state         | nonnegative integer                                    |
| `k8s.container.ready`, `k8s.pod.ready`                       | state         | 1 true, 0 false; -1 unknown                            |
| `k8s.container.state`                                        | state         | 1, with structured state/reason attributes             |
| `k8s.pod.phase`                                              | state         | 1 Pending, 2 Running, 3 Succeeded, 4 Failed, 5 Unknown |
| `k8s.deployment.replicas.desired/available/unavailable`      | state         | replica counts                                         |
| `k8s.node.condition_*`                                       | state         | 1 true, 0 false, -1 unknown                            |

Collector aliases such as `container.cpu.usage`, `k8s.container.cpu_limit` and
`k8s.container.restarts` normalize to those names. Source name, scope, network labels
and sum temporality remain in attributes. Gauge values and monotonic sums are supported;
non-monotonic scalar sums map to gauges while retaining their original semantics.
Histograms, exponential histograms and summaries are explicitly rejected. No cumulative
CPU-time counter is mistaken for CPU usage.

## Ingestion

`POST /v1/otlp/metrics` accepts OTLP/HTTP JSON, including gzip, with the same
`X-Faultline-Cluster-ID` and `X-Faultline-Agent-Token` headers as logs.
Requests are limited to 2 MiB after decompression and 256 data points.
Valid points are normalized and published, then acknowledged with HTTP 200 and `{}`.
Permanent point failures use OTLP `partialSuccess.rejectedDataPoints`; malformed
envelopes/oversized batches receive 400; queue failure receives retryable 503.
Integers beyond JavaScript's exact range are rejected rather than rounded.

`POST /v1/telemetry/metrics` still accepts one existing metric object, and also accepts:

```json
{
  "records": [
    {
      "timestamp": "2026-09-08T12:00:00Z",
      "namespace": "payments",
      "pod": "payment-api-1",
      "container": "api",
      "name": "k8s.container.memory.usage",
      "value": 460,
      "unit": "MiB"
    },
    {
      "timestamp": "2026-09-08T12:00:00Z",
      "namespace": "payments",
      "pod": "payment-api-1",
      "container": "api",
      "name": "k8s.container.memory.limit",
      "value": 512,
      "unit": "MiB"
    }
  ]
}
```

Use current timestamps when exercising state. REST batches contain 1–256 records.
The entire batch validates before any publication. HTTP 202 reports accepted count
and per-record IDs/timestamps. Ingestion does no utilization/restart calculations.
Queue publication remains sequential and nontransactional: a mid-batch queue failure
can leave a published prefix, and a retry can repeat it. This development queue remains
process-local, bounded and nondurable; acknowledgement is not a persistence guarantee.

## Processor state

`ResourceStateStore` is injected into the processor; `InMemoryResourceState` is the
current implementation. Its constructor accepts TTL, resource capacity and a clock.
Defaults are 120 seconds per field and 10,000 resources, with LRU capacity eviction.
A 30-second sweep removes expired entries; reads and updates also enforce expiration.
Restarting the processor loses all state.

Each field has its own observation timestamp. Older/equal samples do not overwrite
newer samples for that field; exact ties are first-wins. Ordering preserves nanoseconds.
Expired replays and samples over 60 seconds in the future are ignored.
Fields from different scrapes are an approximate current view, not an atomic snapshot.

CPU fields are stored in cores and memory fields in bytes. Unit conversion and pure
utilization arithmetic live in `resource-state/calculations.ts`. Utilization is
`usage / positive limit * 100`, rounded to two decimals, without severity or clamping.
Missing, zero, expired or incompatible limits produce no utilization value.
Fresh usage cannot keep a stale limit alive.

Restart tracking reports previous count, current count and delta. First observations
have no delta. A lower count marks a counter reset and has no delta, rather than a
negative restart count or a classification. Equal counts yield zero; duplicate/older
timestamps do not advance the baseline. The reason `Error` or `OOMKilled` is only
an observed Kubernetes status, never a Faultline diagnosis.

Processor logs use `LOG`, `METRIC`, or `KUBERNETES_EVENT`. Metric logs include name,
value, unit and category. `resource_state_updated` logs contain the assembled view and
per-field timestamps. No public state-read endpoint has been added.

## Local setup and verification

Use the existing [setup guide](README.md). The connection ConfigMap now also needs
`metrics-endpoint=http://faultline-ingestion.faultline-system.svc.cluster.local:3001/v1/otlp/metrics`.
Build/load the updated `faultline:dev` image before restarting local Faultline:

```powershell
npm test
npm run validate:collector
docker build -f Dockerfile.dev -t faultline:dev .
docker save faultline:dev -o .local/faultline-metrics-image.tar
.\.local\kind.exe load image-archive .local/faultline-metrics-image.tar --name faultline
kubectl --context kind-faultline apply -k deploy/kubernetes
# Dedicated local kind only: its kubelet serving certificate is self-signed.
kubectl --context kind-faultline -n faultline-system set env daemonset/faultline-collector-logs KUBELET_INSECURE_SKIP_VERIFY=true
kubectl --context kind-faultline -n faultline-system rollout restart deployment/faultline-dev
kubectl --context kind-faultline apply -f deploy/kubernetes/local/workload-metrics.yaml
kubectl --context kind-faultline apply -f deploy/kubernetes/local/workload.yaml
npm run verify:metrics
npm run verify:kubernetes
```

Base manifests validate kubelet TLS. Outside this dedicated local example, configure a
trusted kubelet CA and leave verification enabled. The DaemonSet gains only
`get nodes/stats` and read-only ReplicaSet access; the cluster receiver needs read-only node/workload informer access.
Neither service account can read Secrets or write Kubernetes resources.

The local workload reuses the `faultline:dev` Node image. It grows a touched memory
buffer by 1 MiB every five seconds to 24 MiB by default (`MAX_MEMORY_MIB` is clamped
to 48). CPU busy work is three milliseconds per second, capped at five.
It sends at most one 16 KiB internal HTTP request per second. Container limits are
250m CPU and 192Mi memory; resource requests/limits remain configurable in the manifest.
Keep enough headroom for Node when changing limits; this demo is not an OOM generator.

To exercise readiness failure and exactly one container restart without replacing the pod:

```powershell
kubectl --context kind-faultline -n faultline-demo exec deployment/telemetry-demo -- touch /control/not-ready
# Wait for the next 15-second scrape and inspect resource_state_updated.
kubectl --context kind-faultline -n faultline-demo exec deployment/telemetry-demo -- rm /control/not-ready
kubectl --context kind-faultline -n faultline-demo exec deployment/telemetry-demo -- touch /control/restart
```

The restart marker is consumed before exiting, so it cannot create a restart loop.
The verifier reads actual processor logs and the current pod UID/spec/status. It requires
a fresh complete container view and coverage of pod/node usage, network directions,
filesystem, deployment counts, readiness and requests. It fails after 90 seconds rather
than claiming success from synthetic fixtures. Captured results are in
`evidence/metrics-live.json`, `evidence/readiness-failed.json`, and
`evidence/restart-change.json`.
