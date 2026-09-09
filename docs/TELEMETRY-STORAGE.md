# Telemetry storage and search

Faultline retains the telemetry that explains _why_ an incident happened, without
coupling that high-volume storage to real-time detection.

```
                          ┌── Storage Consumer ──→ ClickHouse
                          │      (apps/storage)         ↑
Kubernetes → Ingestion → Broker                         │ telemetry history
                          │                             │
                          └── Processor ──→ Rule Engine │
                                              ↓         │
                                          Anomalies     │
                                              ↓         │
                                         Correlation    │
                                              ↓         │
                                          Incidents ────┘ evidence window
                                              ↓
                                          PostgreSQL
```

## Datastore responsibilities

| Store          | Owns                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| **PostgreSQL** | Durable business/control-plane state: incidents, anomalies, evidence references             |
| **Redis**      | Temporary operational state: expiring resource fields, rule windows, processed-message keys |
| **NATS**       | Durable asynchronous transport between independent consumers                                |
| **ClickHouse** | High-volume telemetry history: logs, metrics, Kubernetes events                             |

PostgreSQL incident storage is unchanged by this iteration. No raw telemetry is copied
into it; incidents reference telemetry by event ID, time range and resource ID.

## The storage abstraction

Domain and application code depends on `TelemetryStore` from `@faultline/telemetry`,
never on a ClickHouse client:

```ts
storeLogs()   storeMetrics()   storeKubernetesEvents()
searchLogs()  queryMetrics()   searchKubernetesEvents()  getResourceTimeline()
```

Two adapters implement it:

- `ClickHouseTelemetryStore` (`@faultline/clickhouse`) is the production adapter and the
  only place in the platform that imports `@clickhouse/client`.
- `InMemoryTelemetryStore` (`@faultline/telemetry`) backs `NODE_ENV=test` and the
  development pipeline. It is a faithful reference implementation of the query
  semantics, and `tests/telemetry-store-contract.cjs` runs the same suite against both.

## Separating processing from storage

`apps/storage` is a separate service with its own durable JetStream consumer on
`telemetry.raw`. It is deliberately **not** a step inside the processor:

- Detection and storage read the same subject on two independent durable consumers
  (`BROKER_CONSUMER_GROUP` and `TELEMETRY_STORAGE_CONSUMER_GROUP`), each with its own
  cursor and its own retry budget. Configuration validation rejects the two being equal,
  because a shared group would split the subject between them instead of fanning out.
- A ClickHouse outage stalls and retries storage only. Rules, anomalies, correlation and
  incidents keep running, so diagnosis continues while history is unavailable.
- The processor has no ClickHouse dependency at all. `CLICKHOUSE_URL` is required at
  startup for `api` and `storage`, and the processor neither reads it nor probes
  ClickHouse in its readiness check.

Acknowledgement is tied to the batch. `TelemetryBatcher.add()` resolves only after the
batch containing that message has been written, and the consumer returns only then, so
an unwritten message is redelivered rather than lost. That requires more than one
in-flight message, so the storage subscription raises `maxAckPending` to twice the batch
size and sets `ackWait` well above the batch age bound.

Storage runs with a larger `BROKER_MAX_DELIVER` and `BROKER_RETRY_DELAY_MS` than the
processor so it tolerates a longer outage before dead-lettering. Anything that does
exhaust its retries is preserved on `deadletter.telemetry.raw` with its failure reason.

## Batching

Both bounds are configurable and whichever is reached first wins:

| Variable                     | Default | Meaning                                         |
| ---------------------------- | ------- | ----------------------------------------------- |
| `TELEMETRY_BATCH_MAX_SIZE`   | `500`   | Rows buffered before an insert                  |
| `TELEMETRY_BATCH_MAX_AGE_MS` | `2000`  | Age of the oldest buffered row before an insert |

Telemetry is never inserted a row at a time. Logs, metrics and Kubernetes events batch
independently, so a quiet signal cannot delay a busy one. On SIGTERM/SIGINT the consumer
unsubscribes, then flushes every partial batch before the process exits.

## ClickHouse schema

Three tables, all `ReplacingMergeTree`, all partitioned `BY toDate(event_timestamp)`.

| Table                         | ORDER BY                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `telemetry_logs`              | `cluster_id, namespace, workload, severity, event_timestamp, event_id`               |
| `telemetry_metrics`           | `cluster_id, namespace, workload, metric_name, container, event_timestamp, event_id` |
| `telemetry_kubernetes_events` | `cluster_id, namespace, resource_name, event_timestamp, event_id`                    |

### Why this ordering

The queries Faultline actually issues all name a cluster, then narrow by namespace and
workload, then bound time:

1. **logs for a workload over time** — matched by the `cluster/namespace/workload` prefix.
2. **errors for a cluster during an incident** — `severity` sits before `event_timestamp`
   in the log key, so an error-only scan skips the granules of every other severity.
3. **events for a specific pod** — the event key leads with the involved resource name,
   and a bloom filter covers `pod`.
4. **memory metrics for a container** — `metric_name` then `container` precede time, so
   one metric for one container is a contiguous range rather than a filter over all
   metrics.
5. **all telemetry around an incident window** — day partitions bound every table.

`cluster_id` leads every key so tenant isolation is a prefix scan rather than a filter
over the whole table. The trailing `event_id` makes each sort key unique, which is what
lets `ReplacingMergeTree` collapse a redelivered event instead of storing it twice.

### Why day partitions

Day partitions match both the maximum query window the API allows and the retention TTL.
Expiry drops whole partitions, and a bounded query touches a bounded number of them.
Hour partitions would multiply part counts for no gain at this volume; month partitions
would make TTL rewrite large parts.

### Data-skipping indexes

Deliberately few: a `tokenbf_v1` index over `lowerUTF8(message)`, bloom filters on the
identifiers that appear in queries but sit late in the sort key (`pod`, `resource_name`,
`trace_id`, `event_id`), and a `set` index on event `reason`. The message index is
declared on the same expression the query filters on (`lowerUTF8(message) LIKE ...`),
because a token bloom filter only applies to `LIKE`-family predicates over its exact
expression — filtering with `position(...)` would silently read every granule.

### Deduplication

`ReplacingMergeTree` collapses duplicates during background merges, which is eventual.
Reads therefore also apply `LIMIT 1 BY event_id`, and metric aggregation deduplicates in
a subquery before aggregating, so a redelivered sample cannot skew `avg` or `count`.

## Retention

| Variable                                     | Default | Signal            |
| -------------------------------------------- | ------- | ----------------- |
| `TELEMETRY_RETENTION_LOGS_DAYS`              | `7`     | Logs              |
| `TELEMETRY_RETENTION_METRICS_DAYS`           | `14`    | Metrics           |
| `TELEMETRY_RETENTION_KUBERNETES_EVENTS_DAYS` | `30`    | Kubernetes events |

Retention is expressed as a ClickHouse-native `TTL ... DELETE` clause, so ClickHouse
expires rows during merges and Faultline runs no delete job. Applying the schema also
issues `ALTER TABLE ... MODIFY TTL`, so changing a retention setting and re-running
`npm run telemetry:retention` reconciles the tables without a hand-written migration.

**No production retention period is hardcoded.** The defaults above are development
defaults; every deployment sets its own.

### The tradeoff

- **Retention vs storage cost** is close to linear. Logs dominate volume by a wide
  margin, metrics are mid-sized and compress extremely well (`LowCardinality` identity
  columns plus a `Float64`), and Kubernetes events are tiny. The defaults therefore keep
  the shortest window on the most expensive signal and the longest on the cheapest one —
  which is also the one most useful as a long-lived record of control-plane behaviour.
- **Retention vs query performance** is mostly _not_ a tradeoff here. Queries are
  partitioned by day and bounded by the query layer, so a 12-minute investigation reads
  the same number of partitions whether the table holds one week or one year. What does
  grow with retention is background merge work, total part count, and the blast radius of
  an accidentally wide scan — the last of which is why maximum time range, result size
  and execution time are enforced rather than advisory.
- **Shortening retention** is cheap to do and irreversible in effect: expired rows are
  gone, and an incident older than the window can no longer be explained from telemetry.
  Incidents themselves live in PostgreSQL and outlive telemetry retention, so an old
  incident keeps its structured evidence while losing the raw history behind it.

## Oversized telemetry

Faultline **truncates and flags**; it never rejects and never drops a record. A truncated
message still identifies the workload, the severity and the moment — which is most of its
diagnostic value — whereas rejecting it loses the signal exactly when something is going
wrong, and external blob storage is not worth the operational surface at this stage.

| Variable                              | Default | Applies to                    |
| ------------------------------------- | ------- | ----------------------------- |
| `TELEMETRY_MAX_MESSAGE_BYTES`         | `32768` | Log and Kubernetes event text |
| `TELEMETRY_MAX_RAW_PAYLOAD_BYTES`     | `65536` | Retained original payload     |
| `TELEMETRY_MAX_ATTRIBUTE_VALUE_BYTES` | `4096`  | One attribute value           |
| `TELEMETRY_MAX_ATTRIBUTE_COUNT`       | `128`   | Attributes kept per record    |

Truncation happens on a UTF-8 code point boundary, appends `[truncated]`, and sets
`messageTruncated` / `rawPayloadTruncated` on the stored row so a reader can tell
truncated data from short data. Attributes beyond the count limit are dropped in sorted
key order, which is deterministic rather than arbitrary. Raw payloads are retained
because they are valuable for debugging, but they are bounded rather than mirrored.

## Schema evolution

Important searchable fields are real columns; everything else lives in
`attributes Map(String, String)`. A new Kubernetes attribute needs no migration — it
appears in the map and is queryable immediately. Every row carries `schema_version`
(`TELEMETRY_STORAGE_SCHEMA_VERSION`), recording which mapping produced it, and the
adapters treat absent optional fields as empty rather than as errors.

## Query safety

Every telemetry read is bounded before it reaches ClickHouse:

| Variable                              | Default     | Bound                                 |
| ------------------------------------- | ----------- | ------------------------------------- |
| `TELEMETRY_QUERY_MAX_RANGE_MS`        | `86400000`  | Widest log/event/timeline window      |
| `TELEMETRY_QUERY_MAX_METRIC_RANGE_MS` | `604800000` | Widest metric aggregation window      |
| `TELEMETRY_QUERY_MAX_LIMIT`           | `500`       | Largest page                          |
| `TELEMETRY_QUERY_DEFAULT_LIMIT`       | `100`       | Page size when unspecified            |
| `TELEMETRY_QUERY_TIMEOUT_MS`          | `10000`     | Client abort and `max_execution_time` |
| `TELEMETRY_QUERY_MIN_BUCKET_MS`       | `1000`      | Narrowest metric bucket               |
| `TELEMETRY_QUERY_MAX_BUCKETS`         | `1000`      | Points in one aggregation response    |

- A cluster and both window ends are **mandatory**. There is no implicit "last hour"
  default, because silently narrowing a query hides that it was narrowed.
- Filter values must look like Kubernetes identifiers; free-text search is length-capped
  and rejects control characters.
- Result sizes are clamped rather than rejected, so an oversized page request still
  returns bounded data.
- **No endpoint accepts SQL.** Query structure is written in the adapter; caller input
  reaches ClickHouse only as a bound `query_params` value. Database names — the one value
  that cannot be bound — are validated against a strict identifier pattern.
- ClickHouse enforces its own ceilings server-side (`max_execution_time`,
  `max_result_rows`, both with `throw` overflow modes) so a pathological query fails
  instead of pinning a node.

## Multi-cluster isolation

A cluster ID in a query string is a **filter, never an authorization claim**.

`TelemetryScopeResolver` in `apps/api` resolves the authorized clusters from deployment
configuration (`TELEMETRY_QUERY_CLUSTER_SCOPE`), taking no request input at all. The
resolved `TelemetryScope` is passed to every store method, and each adapter re-applies
the authorized cluster list _inside_ the query it builds — so a request cannot reach
another organization's telemetry even if a controller forgot to check. A request naming a
cluster outside the scope gets `403`.

Outside production an unset scope means "all clusters", a development convenience the
ClickHouse adapter refuses when `NODE_ENV=production`. In production
`TELEMETRY_QUERY_CLUSTER_SCOPE` is required at startup and the resolver fails closed.

When per-user RBAC arrives it replaces `ConfiguredTelemetryScopeResolver` and nothing
else, because every read path already asks for a scope before touching storage.

## API

All endpoints are read-only, return `Cache-Control: no-store`, and require a bounded
window. Errors: `400` invalid filter or window, `403` cluster outside scope, `404`
unknown incident, `503` telemetry storage unavailable.

### `GET /telemetry/logs`

Filters: `clusterId`, `namespace`, `workload`, `pod`, `container`, `node`, `severity`
(comma-separated), `search`, `traceId`, `startTime`, `endTime`, `limit`, `cursor`.

Returns `{ items, nextCursor?, query }`. Pagination is keyset-based on
`(eventTimestamp, eventId)` descending; pass `nextCursor` back as `cursor` to continue.

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/telemetry/logs?namespace=faultline-demo&severity=error,fatal&startTime=2026-09-09T12:00:00Z&endTime=2026-09-09T12:15:00Z&limit=50"
```

### `GET /telemetry/metrics`

Filters: `clusterId`, `metricName` (required), `namespace`, `workload`, `pod`,
`container`, `node`, `startTime`, `endTime`, `bucket` (milliseconds),
`aggregations` (`min,max,avg,count`).

Returns one row per bucket per series. This is intentionally not a query language — there
are no operators, joins or expressions, only filters and bucketed aggregates.

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/telemetry/metrics?metricName=k8s.container.memory.usage&container=api&bucket=30000&aggregations=max,avg&startTime=2026-09-09T12:00:00Z&endTime=2026-09-09T12:15:00Z"
```

### `GET /telemetry/kubernetes-events`

Filters: `clusterId`, `namespace`, `workload`, `pod`, `node`, `reason`, `type`,
`resourceName`, `resourceKind`, plus window, `limit` and `cursor`. `BackOff`,
`OOMKilling`, `FailedScheduling`, `FailedMount`, `Unhealthy` and `Evicted` are queryable
alongside logs and metrics because all three signals share the same identity columns.

### `GET /resources/:resourceId/timeline`

Answers "what happened to this workload between 12:00 and 12:15" — logs, Kubernetes
events and important metric samples for one resource in one window.

`resourceId` is `<scope>:<clusterId>:<namespace>:<name>[:<container>]` with each segment
percent-encoded, where scope is `container`, `pod`, `workload`, `node` or `namespace`:

```
container:production-eu:payments:payment-api-7d9f:api
pod:production-eu:payments:payment-api-7d9f
workload:production-eu:payments:payment-api
```

Query parameters: `startTime`, `endTime`, `limit`, `severity`, `metricNames`. Each signal
is capped at `limit` and the response reports which were truncated. Kubernetes events are
matched at pod scope even for a container resource, because that is where Kubernetes
records them.

### `GET /incidents/:id/evidence`

Connects an incident in PostgreSQL to its telemetry in ClickHouse without copying
telemetry between them. Returns:

- `window` — the incident's own span padded by `leadMs` (default 120000) and `trailMs`
  (default 300000), clipped to the maximum query range around the most recent activity
- `resources` — every affected resource as a timeline-ready `resourceId`
- `eventIds` — telemetry event IDs already referenced by the incident's structured evidence
- `anomalyEvidence` — the small structured evidence rows PostgreSQL does store
- `queryContext` — the exact cluster, window, resources, severities and metric names used,
  so a later diagnosis system can re-run or widen the same retrieval
- `telemetry` — the error logs, warning events and metric samples retrieved for that window

```
Incident #123 → evidence window 11:58 → 12:07 → ClickHouse → logs + metrics + events
```

## Health checks

`GET /health` is liveness. `GET /health/ready` probes dependencies, which are now either
**critical** (failure returns `503`) or **non-critical** (failure reports
`status: "degraded"` and lists the dependency under `degraded`, still `200`):

| Service   | Critical                | Non-critical |
| --------- | ----------------------- | ------------ |
| api       | PostgreSQL              | ClickHouse   |
| ingestion | NATS                    | —            |
| processor | PostgreSQL, Redis, NATS | —            |
| storage   | NATS, ClickHouse        | —            |

Telemetry persistence is deliberately decoupled from detection. The storage consumer
becomes unhealthy when ClickHouse is down, but nothing about that stops the processor,
and the API keeps serving incidents while reporting itself degraded.

Storage also verifies the schema at startup and refuses to boot without it, so a missing
or unreachable ClickHouse is a visible crash-loop rather than silent data loss: JetStream
retains `telemetry.raw` meanwhile, and the consumer drains its backlog once ClickHouse
returns. The processor is unaffected throughout.

## Local development

ClickHouse joins PostgreSQL, Redis and NATS in `compose.infrastructure.yml`.

### Start it

```powershell
Copy-Item .env.infrastructure.example .env.infrastructure
Copy-Item apps/storage/.env.example apps/storage/.env
# Set one matching CLICKHOUSE_PASSWORD in .env.infrastructure, apps/api/.env and apps/storage/.env.
npm run infra:up
```

The server listens on `127.0.0.1:8123` (`CLICKHOUSE_HTTP_PORT`) and keeps its data in the
named volume `faultline-clickhouse`, which survives `npm run infra:down`.

### Create the schema

Schema creation is a deployment step; no service creates tables on startup, exactly like
the PostgreSQL migrations.

```powershell
$env:CLICKHOUSE_URL = "http://127.0.0.1:8123"
$env:CLICKHOUSE_USERNAME = "faultline"
$env:CLICKHOUSE_PASSWORD = "<secret>"
npm run telemetry:schema      # create database, tables and TTLs (safe to re-run)
npm run telemetry:retention   # reconcile TTLs after changing retention settings
```

`/health/ready` reports ClickHouse as unavailable until the schema exists, so a missing
schema is visible rather than silent.

### Inspect stored telemetry

Through the API:

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/telemetry/logs?clusterId=development-cluster&startTime=$((Get-Date).AddMinutes(-15).ToUniversalTime().ToString('o'))&endTime=$((Get-Date).ToUniversalTime().ToString('o'))"
```

Directly, over ClickHouse's HTTP interface:

```powershell
$ch = @{ Uri = "http://127.0.0.1:8123"; Headers = @{ "X-ClickHouse-User" = "faultline"; "X-ClickHouse-Key" = "<secret>" } }
Invoke-RestMethod @ch -Method Post -Body "SELECT count() FROM faultline.telemetry_logs"
Invoke-RestMethod @ch -Method Post -Body "SELECT event_timestamp, severity, pod, message FROM faultline.telemetry_logs ORDER BY event_timestamp DESC LIMIT 20 FORMAT PrettyCompact"
Invoke-RestMethod @ch -Method Post -Body "SELECT reason, count() FROM faultline.telemetry_kubernetes_events GROUP BY reason FORMAT PrettyCompact"
Invoke-RestMethod @ch -Method Post -Body "SELECT name, engine_full FROM system.tables WHERE database='faultline' FORMAT Vertical"
```

### Clear development telemetry

```powershell
npm run telemetry:clear
```

This truncates all three tables and keeps the schema. It refuses to run when
`NODE_ENV=production`. To discard everything including the schema, remove the volume with
`docker compose -f compose.infrastructure.yml down -v`.

## Tests

`npm test` runs the full storage suite against the in-memory adapter, with no
infrastructure required: the shared store contract, batching bounds and shutdown flush,
storage-failure isolation, retention, query safety, resource identifiers, oversized
payloads, schema evolution, API scoping and pagination, and the end-to-end scenario
(`ERROR log → Kubernetes event → rising memory → incident → telemetry persisted →
incident API → timeline query`).

The ClickHouse integration suite runs the same contract against a real server, plus the
applied schema, native TTLs, batched inserts and server-side limits:

```powershell
npm run infra:up
$env:CLICKHOUSE_URL = "http://127.0.0.1:8123"
$env:CLICKHOUSE_USERNAME = "faultline"; $env:CLICKHOUSE_PASSWORD = "<secret>"
$env:RUN_CLICKHOUSE_TESTS = "true"
npm run test:clickhouse
```

It uses the separate database `faultline_test` (`CLICKHOUSE_TEST_DATABASE`) so it never
touches development telemetry, and skips with a message when the variables are unset.
