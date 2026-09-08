# Faultline

## Metrics and workload state

The [metrics guide](deploy/kubernetes/METRICS.md) describes CPU/memory usage, resource requests/limits,
readiness, restarts and workload state. Metric batches enter `POST /v1/otlp/metrics`
or `POST /v1/telemetry/metrics`. Processor state expires per field, calculates
utilization, and supplies current state to deterministic anomaly rules. Run
`npm run verify:metrics` against the local cluster.

## Kubernetes and OpenTelemetry

The [Kubernetes deployment guide](deploy/kubernetes/README.md) includes a Collector
DaemonSet for container logs, a single event collector, minimal RBAC, Secret-based
headers, a kind demo workload and verification commands. Collector batches enter
`POST /v1/otlp/logs` as OTLP/HTTP JSON and become the existing shared telemetry events.

Use `npm run validate:collector` to validate configuration with the pinned Collector
image, and `npm run verify:kubernetes` to check stdout, stderr and Kubernetes Events
in the local deployment's processor logs. See [verification status](deploy/kubernetes/VERIFICATION.md)
for the completed live-cluster checks and captured evidence.

## Working development telemetry pipeline

Run these commands from `faultline` in PowerShell:

```powershell
npm ci
$env:NODE_ENV = "development"
$env:APP_VERSION = "0.1.0"
$env:FAULTLINE_DEV_AGENT_TOKEN = "your-local-development-token"
npm run dev:pipeline
```

The launcher builds and starts processor, ingestion, and API as separate Nest
applications in one Node process. Processor and ingestion share the development queue;
processor and API share the temporary incident repository. Ingestion does not import
processor logic. Process-local adapters cannot cross standalone process boundaries.
The combined launcher uses ports 3000, 3001, and 3002, overridden by `API_PORT`,
`INGESTION_PORT`, and `PROCESSOR_PORT`; it overrides `PORT`. Stop with Ctrl+C to drain
accepted work. All three apps expose `/health` and `/health/ready`.

In another PowerShell terminal:

```powershell
$env:NODE_ENV = "development"
$env:FAULTLINE_DEV_AGENT_TOKEN = "your-local-development-token"
npm run telemetry:sample
```

The client sends a normal log, ERROR log, CPU metric, memory metric, BackOff event
and simulated OOMKilled-related event. It requires `NODE_ENV=development`.
Optional settings: `FAULTLINE_INGESTION_URL` (default `http://127.0.0.1:3001`) and
`FAULTLINE_CLUSTER_ID` (default `development-cluster`). No sample HTTP endpoint is exposed.

Individual examples:

```powershell
$headers = @{ "X-Faultline-Cluster-ID" = "development-cluster"; "X-Faultline-Agent-Token" = $env:FAULTLINE_DEV_AGENT_TOKEN }
Invoke-RestMethod http://localhost:3001/v1/telemetry/logs -Method Post -Headers $headers -ContentType 'application/json' -Body '{"timestamp":"2026-09-08T10:00:00Z","service":"payment-api","level":"info","message":"Payment completed","stream":"stdout"}'
Invoke-RestMethod http://localhost:3001/v1/telemetry/metrics -Method Post -Headers $headers -ContentType 'application/json' -Body '{"timestamp":"2026-09-08T10:00:00Z","name":"k8s.container.cpu.usage","value":0.42,"unit":"cores"}'
Invoke-RestMethod http://localhost:3001/v1/telemetry/kubernetes-events -Method Post -Headers $headers -ContentType 'application/json' -Body '{"timestamp":"2026-09-08T10:00:00Z","type":"Warning","reason":"BackOff","message":"Back-off restarting failed container","count":1,"involvedObject":{"apiVersion":"v1","kind":"Pod","name":"payment-api-1"}}'
```

HTTP 202 returns `status=accepted`, `eventId` and `ingestedAt`. Match the ID with
the processor JSON log's `message.event_id`: `event=telemetry_processed`,
`type=LOG|METRIC|KUBERNETES_EVENT`, `cluster_id`, optional `service`,
`processor=faultline-processor`, `status=processed`. Processing logs preserve original
`timestamp` and include `ingestedAt` and `processedAt`. Tokens and raw payloads are
not logged. Matching telemetry also produces structured anomaly and incident lifecycle
logs. The API at `http://localhost:3000/incidents` reads correlated incidents created by
the combined development process.

Requests require both cluster and token headers. The development token is shared and
permits any nonempty cluster ID; it does not establish cluster ownership.
`ClusterAuthenticator` is the interface to replace with credential storage later.
Missing token configuration prevents combined startup; standalone ingestion returns 503.

Request `id` is optional (UUID generated), `raw` defaults to null, `attributes` to `{}`,
and `metricType` to `gauge`. Severity uses the existing lowercase `level` field.
Kubernetes metadata stays optional. If supplied, body `clusterId` must match the header;
the involved resource's cluster defaults to the header and must also match.
`kind` may be omitted; when supplied it must match the endpoint. Unknown request fields
and client-supplied pipeline timestamps are rejected. Base contracts keep pipeline
timestamps optional for compatibility; processor validation requires `ingestedAt`.

Errors: 400 for malformed telemetry, missing cluster ID, cluster mismatch or unsupported
`kind`; 401 for missing/invalid tokens; 404 for unknown routes; 503 for unconfigured
authentication or queue publishing failure. Internal malformed events are rejected and
logged. Processor failures are logged and reported to the adapter. A 202 acknowledges
queue acceptance only, not processing success.

The DEVELOPMENT ONLY adapter holds at most 1000 pending deliveries, requires an active
subscriber, isolates message copies and drains handlers on close. Publication does not
wait for processing. Delivery is at-most-once with no retry, deduplication, persistence
or crash recovery. Standalone ingestion returns 503 without a local subscriber.
Production startup rejects this adapter; distributed deployment needs a durable broker.

`npm test` covers HTTP-to-processor delivery for all telemetry variants, authentication,
validation, queue behavior, anomaly rules, incident correlation/lifecycle, API filtering,
and the full memory-failure-to-incident scenario alongside the foundation tests.

NestJS + TypeScript foundation for a Kubernetes production diagnostics platform.
Requires Node.js 22+ and npm. All workspaces are private.

| Workspace             | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `apps/api`            | REST control plane; system and incident reads (port 3000)             |
| `apps/ingestion`      | Validated telemetry receiver (port 3001)                              |
| `apps/processor`      | Resource state, anomaly rules, and incident correlation (port 3002)   |
| `packages/platform`   | Shared validated configuration, JSON logger, health and bootstrap     |
| `packages/telemetry`  | Telemetry metadata, log/metric/Kubernetes event types and Zod schemas |
| `packages/kubernetes` | Cluster, namespace, deployment, pod, container and node identities    |
| `packages/incidents`  | Separate incident and diagnostic anomaly domain contracts             |
| `packages/database`   | Repository/database interfaces and injection token                    |
| `packages/queue`      | Producer/consumer/subscription interfaces and injection token         |

The small platform library keeps NestJS concerns separate from domain contracts.
Only the three apps start processes. Libraries have no start command.

## Run

From this directory, install and build:

```sh
npm ci
npm run build
```

Copy each app's `.env.example` to `.env` in the same directory, or supply the
required settings through the process environment. On PowerShell:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/ingestion/.env.example apps/ingestion/.env
Copy-Item apps/processor/.env.example apps/processor/.env
```

For standalone health checks, run each application in a separate terminal. These processes do not share the in-memory queue:

```sh
npm run start:api
npm run start:ingestion
npm run start:processor
```

For development use `npm run dev:api`, `npm run dev:ingestion`, or
`npm run dev:processor`. Each builds first, then watches TypeScript and restarts
Node when compiled dependencies change. Run one TypeScript watcher at a time;
other apps can use `node --watch apps/<app>/dist/main.js`.

## Configuration and logging

Each application reads only `apps/<app>/.env`, independent of the working directory.
Process environment variables override file values. Configuration is validated once
at startup and injected as a typed, frozen `ApplicationConfig`.

| Variable                           | Requirement                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`                         | Required: `development`, `test`, or `production`                                 |
| `APP_VERSION`                      | Required: nonempty release identifier, e.g. `0.1.0` or a commit SHA              |
| `HOST`                             | Optional; defaults to `0.0.0.0`                                                  |
| `PORT`                             | Optional integer 1–65535; defaults to 3000/3001/3002 per app                     |
| `LOG_LEVEL`                        | Optional; `fatal`, `error`, `warn`, `log`, `debug`, `verbose`; defaults to `log` |
| `INCIDENT_CORRELATION_WINDOW_MS`   | Optional; related-anomaly window, default `600000`                               |
| `INCIDENT_STABILIZATION_PERIOD_MS` | Optional; healthy interval before resolution, default `120000`                   |

Missing or invalid required settings fail startup with exit code 1. Errors name
fields without logging their values. Set `NODE_ENV=production` and the deployed
`APP_VERSION` in production. Ingestion requires a development agent token. Keep actual tokens out of source control. The development queue is disabled in production.

The reusable `ApplicationLogger` emits one JSON object per line, including
`timestamp` (Unix milliseconds), `application`, `level`, `message`, and optional
Nest context/stack. App identity is retained even in logs from shared code or Nest
internals. The configured level includes higher-severity messages. Inject
`ApplicationLogger` in Nest providers, or instantiate it in adapter code.
Application payloads are not automatically logged or redacted; avoid passing secrets.
Shutdown hooks are enabled for future adapter cleanup.

Processor anomaly thresholds are environment variables. Defaults are 85/95 percent
for memory, 80/95 percent for CPU, 3 restart increases, 60 seconds not-ready, and
120 seconds degraded. Warning percentages must be below their critical percentage.
See `apps/processor/.env.example` for the exact variable names.

## Deterministic anomaly rules

The processor evaluates each normalized event with the latest bounded, in-memory
resource state. Rules are independent `AnomalyRule` implementations registered as a
list, so adding a rule does not require editing a classification switch. The initial
classifications are `OOM_KILLED`, `CRASH_LOOP`, `HIGH_MEMORY_UTILIZATION`,
`HIGH_CPU_UTILIZATION`, `POD_NOT_READY`, `DEPLOYMENT_DEGRADED`,
`FAILED_SCHEDULING`, `IMAGE_PULL_FAILURE`, `FAILED_MOUNT`, and `NODE_NOT_READY`.

Utilization rules require two high samples. Crash-loop detection requires repeated
restart increases plus Kubernetes BackOff/CrashLoopBackOff evidence. Readiness and
deployment rules use configured event-time durations. Native failure reasons can
open immediately. Exact event IDs and older samples are ignored, and a classification
plus resource key identifies one active anomaly. Its lifecycle is `OPEN`, then
`ACTIVE` on confirmation, and `RESOLVED` when healthy telemetry clears the condition.
Anomaly output includes its stable ID, rule/classification, severity, confidence,
affected resource, summary, timestamps, and bounded supporting evidence.

Anomaly lifecycle state is local to the processor process and is lost on restart.

## Incident correlation

The processor feeds emitted anomalies into a deterministic correlation engine. It uses
cluster, namespace, Kubernetes ownership, affected resource, classification relationships,
and a configurable time window. Pod ownership is resolved to a Deployment from explicit
metadata, a ReplicaSet owner, or a conservative pod-name fallback. Original pod and
container identities remain in `affectedResources`.

Initial incident classifications cover memory exhaustion, resource saturation, crashing
workloads, deployment degradation, node failure, workload configuration failure, and
scheduling failure. Incidents retain anomaly snapshots, deduplicated evidence, and a
chronological timeline. Repeated related anomalies update the same incident and can
escalate its severity.

Confidence is an explainable evidence score. A high-memory signal scores 0.45; an
OOMKilled signal scores 0.80; both score 0.90; correlated restart evidence raises the
memory-exhaustion score to 0.98. CrashLoop plus PodNotReady scores 0.92. Multiple affected
replicas increase confidence for deployment, node, and configuration failures. These
fixed scores express evidence completeness and are not probabilities.

When all underlying anomalies resolve, the incident remains `ACTIVE` during
`INCIDENT_STABILIZATION_PERIOD_MS`. Later telemetry advances the stabilization clock;
another active anomaly cancels it. The correlation window defaults to ten minutes and
stabilization defaults to two minutes. Both are configured in `apps/processor/.env`.

The repository is bounded and in memory. In the combined launcher, processor and API
share it because they run in one process. Standalone API and processor processes have
separate repositories, and restarts lose incident state. A durable repository is required
before distributed production deployment.

## Endpoints

All apps expose `GET /health` and `GET /health/ready`:

```json
{ "application": "api", "status": "ok", "uptime": 12.34 }
```

Uptime is process uptime in seconds. Readiness currently means successful bootstrap;
there are no dependency probes. Both responses disable caching.

API only: `GET /system/info`:

```json
{
  "application": "api",
  "environment": "development",
  "version": "0.1.0",
  "enabledComponents": [
    "configuration",
    "logging",
    "health",
    "system-info",
    "incidents"
  ]
}
```

API incident reads:

```text
GET /incidents
GET /incidents/:id
```

The list endpoint supports exact `cluster`, `namespace`, `status`, `severity`, and
`classification` query filters. Enum filters are case-insensitive. Unknown incident IDs
return 404 and invalid filters return 400. Responses disable caching.

Enabled components describe capabilities registered in this process, not the
availability of other apps or future infrastructure.

## Shared contracts

Workspace imports resolve compiled JavaScript and declarations through package exports;
TypeScript project references build dependencies before their consumers:

```ts
import {
  telemetryEventSchema,
  type TelemetryEvent,
} from '@faultline/telemetry';
import type { Pod } from '@faultline/kubernetes';
import type { Incident } from '@faultline/incidents';
import type { QueueProducer } from '@faultline/queue';
import type { Repository } from '@faultline/database';
import { ApplicationLogger } from '@faultline/platform';
```

`TelemetryEvent` is a discriminated union with `kind` equal to `log`, `metric`,
or `kubernetes`. Exported types are inferred from their schemas. All events require
`id`, `timestamp` (ISO 8601 with timezone), `clusterId`, and `raw` (a JSON value;
use `null` when unavailable). Optional metadata: `namespace`, `pod`, `container`,
`node`, `service`, and `workload`. JSON `attributes` default to an empty object.
Parsers preserve defined metadata and strip unknown top-level keys; put custom
fields in `attributes` or `raw`.

Log events add `level` and `message`; scalar metric events add `name`, finite
`value`, `metricType` (`gauge` or `counter`), and optional `unit`; Kubernetes
events add `type` (`Normal` or `Warning`), `reason`, `message`, `involvedObject`,
and optional positive `count`. The involved object must match the event's cluster.
The original `TelemetryEnvelope` remains deprecated for compatibility; use the
new union for the ingestion pipeline.

Kubernetes identities distinguish cluster-scoped resources, namespaced resources,
and containers nested within pods. Incident contracts define anomaly snapshots,
affected resources, evidence, timeline, severity, confidence, and lifecycle. The shared
repository contract is asynchronous so a durable adapter can replace the temporary
in-memory implementation without changing correlation business logic.

The database package exposes interfaces only. The queue includes a development in-memory adapter. Queue handlers signal success by resolving
and failure by rejecting; future adapters must define acknowledgement, retries and
delivery guarantees.

## Verification and boundaries

`npm test` builds and runs config, health, logger and telemetry validation tests,
plus checks for independent app startup, required-config failures, workspace imports
and HTTP endpoints. `npm run typecheck` validates the project graph.

Build before production startup. Deploy the selected app output together with
shared package outputs, workspace manifests and production node_modules.
The development pipeline runs all three apps in one process. Kubernetes collection uses
OpenTelemetry Collector. ML, statistical baselines, root-cause analysis, alerts,
automatic remediation, durable databases and durable brokers remain outside this
iteration.
