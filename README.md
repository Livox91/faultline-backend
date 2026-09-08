# Faultline

NestJS + TypeScript foundation for a Kubernetes production diagnostics platform.
Requires Node.js 22+ and npm. All workspaces are private.

| Workspace | Purpose |
| --- | --- |
| `apps/api` | REST control plane; health and system information (port 3000) |
| `apps/ingestion` | Future Kubernetes telemetry receiver; health only (port 3001) |
| `apps/processor` | Future normalization, correlation and classification; health only (port 3002) |
| `packages/platform` | Shared validated configuration, JSON logger, health and bootstrap |
| `packages/telemetry` | Telemetry metadata, log/metric/Kubernetes event types and Zod schemas |
| `packages/kubernetes` | Cluster, namespace, deployment, pod, container and node identities |
| `packages/incidents` | Incident, severity, status and evidence-reference contracts |
| `packages/database` | Repository/database interfaces and injection token |
| `packages/queue` | Producer/consumer/subscription interfaces and injection token |

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

Run each application in a separate terminal:

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

| Variable | Requirement |
| --- | --- |
| `NODE_ENV` | Required: `development`, `test`, or `production` |
| `APP_VERSION` | Required: nonempty release identifier, e.g. `0.1.0` or a commit SHA |
| `HOST` | Optional; defaults to `0.0.0.0` |
| `PORT` | Optional integer 1–65535; defaults to 3000/3001/3002 per app |
| `LOG_LEVEL` | Optional; `fatal`, `error`, `warn`, `log`, `debug`, `verbose`; defaults to `log` |

Missing or invalid required settings fail startup with exit code 1. Errors name
fields without logging their values. Set `NODE_ENV=production` and the deployed
`APP_VERSION` in production. No secrets or infrastructure credentials are needed
yet; keep future secrets in deployment environment variables and out of source control.

The reusable `ApplicationLogger` emits one JSON object per line, including
`timestamp` (Unix milliseconds), `application`, `level`, `message`, and optional
Nest context/stack. App identity is retained even in logs from shared code or Nest
internals. The configured level includes higher-severity messages. Inject
`ApplicationLogger` in Nest providers, or instantiate it in adapter code.
Application payloads are not automatically logged or redacted; avoid passing secrets.
Shutdown hooks are enabled for future adapter cleanup.

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
  "enabledComponents": ["configuration", "logging", "health", "system-info"]
}
```

Enabled components describe capabilities registered in this process, not the
availability of other apps or future infrastructure.

## Shared contracts

Workspace imports resolve compiled JavaScript and declarations through package exports;
TypeScript project references build dependencies before their consumers:

```ts
import { telemetryEventSchema, type TelemetryEvent } from '@faultline/telemetry';
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
and containers nested within pods. Incident contracts reference these identities;
classification and confidence can be `null` until available. Confidence range,
timestamp ordering and incident cluster consistency are documented invariants for
future write validation. No incident logic or runtime incident validation exists yet.

Database and queue packages expose interfaces only. No adapter providers are
registered and no connections are opened. Queue handlers signal success by resolving
and failure by rejecting; future adapters must define acknowledgement, retries and
delivery guarantees.

## Verification and boundaries

`npm test` builds and runs config, health, logger and telemetry validation tests,
plus checks for independent app startup, required-config failures, workspace imports
and HTTP endpoints. `npm run typecheck` validates the project graph.

Build before production startup. Deploy the selected app output together with
shared package outputs, workspace manifests and production node_modules.
Apps can run and deploy separately. Collection, OpenTelemetry, anomaly detection,
ML, authentication, incident processing, actual databases and queues remain outside
this iteration.
