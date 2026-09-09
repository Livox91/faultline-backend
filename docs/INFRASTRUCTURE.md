# Durable infrastructure

## Boundaries

PostgreSQL is the permanent incident/control-plane database. It stores clusters,
incident lifecycle fields, classifications, confidence and severity, plus normalized
affected-resource, anomaly-reference, evidence, and timeline rows. One transaction
updates the aggregate and all child rows. Raw logs and metrics are never written to
PostgreSQL; incident evidence references telemetry by event ID, time range and resource
ID, and `GET /incidents/:id/evidence` resolves those references against ClickHouse.

ClickHouse is the high-volume telemetry history: normalized logs, metrics and Kubernetes
events, retained by native per-signal TTL. Domain code reaches it only through the
`TelemetryStore` interface. It is written by `apps/storage`, an independent broker
consumer, and read by the API's telemetry endpoints. The processor has no ClickHouse
dependency, so telemetry persistence can fail without stopping detection. See
[the telemetry storage guide](TELEMETRY-STORAGE.md).

Redis stores expiring resource fields, restart deltas, rule observations/windows,
active anomaly state, evidence windows, and processed-message keys. It is a cache and
operational state store, not the incident system of record. Resource and rule keys
expire automatically.

NATS JetStream owns two file-backed streams:

- `FAULTLINE_EVENTS`: `telemetry.raw`, `telemetry.normalized`,
  `anomalies.detected`, `anomalies.resolved`, and `incidents.updated`
- `FAULTLINE_DEAD_LETTERS`: `deadletter.>`

Every persisted message uses this versioned envelope:

```json
{
  "messageId": "stable-producer-id",
  "eventType": "telemetry.raw",
  "timestamp": "2026-09-08T10:00:00.000Z",
  "source": "faultline-ingestion",
  "schemaVersion": 1,
  "payload": {}
}
```

Only schema version 1 is accepted. Unknown versions fail explicitly and follow the
normal retry/dead-letter path instead of being silently interpreted.

## Delivery and failures

JetStream delivery is **at least once**, never exactly once. Publishers set the NATS
message ID from the stable envelope ID, enabling the stream duplicate window.
Processor consumers also claim the telemetry ID in Redis before work and retain a
completed key afterward. Rule state ignores previously seen event IDs, PostgreSQL has
a unique anomaly reference, and timeline IDs are deterministic. Together these make
redelivery safe without claiming distributed exactly-once semantics.

Consumers acknowledge only after resource state, rules, incident transactions, and
outgoing operational events complete. Failures are negatively acknowledged with a
delay. After `BROKER_MAX_DELIVER` attempts, the original envelope is published to
`deadletter.<original-topic>` with failure-reason and original-topic headers, logged,
and acknowledged so one bad event cannot block later work. NATS clients reconnect
indefinitely with a one-second reconnect delay.

## Local setup

Requirements: Node.js 22+, Docker with Compose, and free local ports 5432, 6379,
4222, 8222, and 8123 (all configurable in `.env.infrastructure`).

```powershell
Copy-Item .env.infrastructure.example .env.infrastructure
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/ingestion/.env.example apps/ingestion/.env
Copy-Item apps/processor/.env.example apps/processor/.env
Copy-Item apps/storage/.env.example apps/storage/.env
```

Replace the placeholder PostgreSQL password in `.env.infrastructure`, `apps/api/.env`,
and `apps/processor/.env` with the same local secret, and the placeholder ClickHouse
password in `.env.infrastructure`, `apps/api/.env`, and `apps/storage/.env` with another.
Do not commit copied `.env` files.

```powershell
npm ci
npm run infra:up
$env:DATABASE_URL = "postgresql://faultline:<password>@127.0.0.1:5432/faultline"
npm run db:migrate
$env:CLICKHOUSE_URL = "http://127.0.0.1:8123"
$env:CLICKHOUSE_USERNAME = "faultline"; $env:CLICKHOUSE_PASSWORD = "<clickhouse-password>"
npm run telemetry:schema
npm run dev:pipeline
```

Send and inspect data:

```powershell
$env:NODE_ENV = "development"
$env:FAULTLINE_DEV_AGENT_TOKEN = "change-me-local-only"
npm run telemetry:sample
Invoke-RestMethod http://127.0.0.1:3000/incidents
Invoke-RestMethod http://127.0.0.1:8222/jsz
Invoke-RestMethod http://127.0.0.1:8123 -Method Post -Body "SELECT count() FROM faultline.telemetry_logs"
```

Stop the app with Ctrl+C, then stop infrastructure with `npm run infra:down`.
Compose does not remove named volumes. To test restart durability, stop and restart
the applications without removing volumes and query `/incidents` again.

`npm run telemetry:clear` truncates development telemetry while keeping the ClickHouse
schema; it refuses to run when `NODE_ENV=production`.

## Migrations

Production startup never synchronizes schema automatically. Run migrations as a
separate deployment step:

```powershell
$env:DATABASE_URL = "postgresql://..."
npm run db:migrate
npm run db:rollback
npm run db:migration:create -- add_incident_field
```

ClickHouse has its own schema step, run the same way and equally never on startup:

```powershell
npm run telemetry:schema      # create database, tables and TTLs; safe to re-run
npm run telemetry:retention   # reconcile TTLs after changing retention settings
```

Applied PostgreSQL versions are recorded in `schema_migrations`. Apply loads ordered SQL files and
runs each unapplied migration transactionally. Rollback removes only the latest
migration and works when that file supplies a down section. The create command makes a
timestamped SQL template under `packages/database/migrations`; after adding reviewed
up/down SQL, the next apply discovers it automatically.

## Configuration

- API: `DATABASE_URL`, `CLICKHOUSE_URL`, and `TELEMETRY_QUERY_CLUSTER_SCOPE` in production
- Ingestion: `BROKER_URL`, `BROKER_CLIENT_ID`, `BROKER_CONSUMER_GROUP`
- Processor: `DATABASE_URL`, `REDIS_URL`, and the broker settings; never ClickHouse
- Storage: `BROKER_URL`, `CLICKHOUSE_URL`, and `TELEMETRY_STORAGE_CONSUMER_GROUP`,
  which must differ from `BROKER_CONSUMER_GROUP`
- Broker tuning: `BROKER_MAX_DELIVER`, `BROKER_RETRY_DELAY_MS`
- Redis expiry: `RESOURCE_STATE_TTL_MS`
- Telemetry batching, retention, payload limits and query safety: see
  [the telemetry storage guide](TELEMETRY-STORAGE.md)

These URLs are mandatory outside test mode and are validated before startup. Test
mode intentionally wires bounded in-memory adapters.

## Health and shutdown

`GET /health` is liveness and only reports process health. `GET /health/ready` probes
dependencies, which are either critical or non-critical:

| Service   | Critical                | Non-critical |
| --------- | ----------------------- | ------------ |
| api       | PostgreSQL              | ClickHouse   |
| ingestion | NATS                    | -            |
| processor | PostgreSQL, Redis, NATS | -            |
| storage   | NATS, ClickHouse        | -            |

A failed critical probe returns HTTP 503. A failed non-critical probe returns 200 with
`status: "degraded"` and names the dependency, so the API keeps serving incidents while
telemetry history is unavailable. The storage consumer can be unhealthy without affecting
the processor at all: they are separate services on separate broker consumers.

On SIGTERM/SIGINT Nest stops HTTP acceptance, the processor unsubscribes and waits for
in-flight handlers, the storage consumer unsubscribes and flushes its partial telemetry
batches, then providers drain NATS and close PostgreSQL/Redis/ClickHouse connections.
Messages are acknowledged only after successful processing - for storage, only after the
batch containing them is written - so unacknowledged work is redelivered after a normal
or abnormal restart.
