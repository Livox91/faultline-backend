# Faultline onboarding for BookNest

This guide takes a new Faultline checkout and an existing Kubernetes cluster running
BookNest to verified log collection and classification. Faultline runs on the customer
machine; only its read-only OpenTelemetry collectors are installed in Kubernetes.

```text
BookNest pod stdout/stderr
          ↓
Faultline Collector (Kubernetes)
          ↓ outbound HTTP/HTTPS
Faultline Ingestion (customer machine, port 3001)
          ↓ NATS JetStream
Processor ── log classification
          ↓
PostgreSQL incidents + ClickHouse telemetry
          ↓
Faultline API (port 3000)
```

## Prerequisites

- Node.js 22 or newer and npm (the repository uses npm workspaces and `package-lock.json`)
- Docker Engine with Docker Compose v2
- `kubectl` configured for the cluster that runs BookNest
- A Linux Kubernetes node whose `/var/log/pods` follows the standard CRI layout
- Permission to create the `faultline-system` namespace, ServiceAccounts, ClusterRoles,
  ClusterRoleBindings, a DaemonSet, and a Deployment
- A hostname or IP that pods can use to reach port 3001 on the customer machine

BookNest's checked-in manifests use namespace `default` and label its backend
`app=booknest-backend`. Pass different values during registration if your deployment
differs.

## 1. Install and generate local configuration

From the `faultline` directory:

```powershell
npm install
npm run setup
npm run preflight
```

`setup` creates, without printing credentials:

- `.env.infrastructure`
- `apps/api/.env`
- `apps/ingestion/.env`
- `apps/processor/.env`
- `apps/storage/.env`
- `.local/onboarding.json`

Existing non-placeholder configuration is preserved. Generated files are ignored by
Git. PostgreSQL and ClickHouse passwords and the development agent token are random.
The complete documented variable list is in `.env.example`; per-service optional
tuning remains in `apps/*/.env.example`.

Preflight checks Node, Docker, `kubectl`, the active cluster, local configuration,
required ports, infrastructure endpoints, and any already-running Faultline services.
Fix every `✗` item before continuing. An `!` saying a service is not running is expected
before the next step.

If a retained PostgreSQL volume was initialized with different credentials, startup
fails closed instead of deleting or rewriting it. Restore the matching credentials, or
use the explicitly destructive development reset below when the retained data is no
longer needed.

## 2. Start Faultline

```powershell
npm run faultline:start
```

This one command:

1. starts PostgreSQL, Redis, NATS JetStream, and ClickHouse through Docker Compose;
2. waits for their health checks;
3. builds every workspace;
4. applies PostgreSQL migrations and the ClickHouse schema idempotently;
5. starts API, ingestion, processor, and storage together in the background; and
6. waits for all four readiness endpoints.

Runtime output is written to `.local/faultline.log`. Health endpoints are:

```text
http://127.0.0.1:3000/health/ready  API
http://127.0.0.1:3001/health/ready  ingestion
http://127.0.0.1:3002/health/ready  processor
http://127.0.0.1:3003/health/ready  storage
```

To initialize schemas without starting applications, use `npm run infra:up` followed by
`npm run infra:init`.

## 3. Register and onboard the BookNest cluster

Choose an ingestion URL reachable **from a Kubernetes pod**. `localhost` is wrong: it
would refer to the collector container.

- Docker Desktop/kind: `http://host.docker.internal:3001`
- Minikube: `http://host.minikube.internal:3001`
- Remote/private cluster: a customer-provided routable HTTPS URL or tunnel

The command infers the first two from the current context. Override it when needed:

```powershell
npm run cluster:onboard -- --id booknest-development --name "BookNest local cluster" --endpoint http://host.docker.internal:3001 --workload-namespace default --workload-label app=booknest-backend
```

For Minikube, use:

```powershell
npm run cluster:onboard -- --endpoint http://host.minikube.internal:3001
```

`cluster:onboard` performs registration, launches a disposable connectivity pod before
installation, and only proceeds when that pod can reach ingestion. It then creates:

- the exclusively-owned `faultline-system` namespace;
- `faultline-logs` and `faultline-events` ServiceAccounts;
- explicit read-only RBAC (no Secret reads, wildcard resources, or write verbs);
- a Secret containing the generated agent token;
- a ConfigMap containing cluster ID and complete OTLP endpoints;
- a log/metrics Collector DaemonSet; and
- one Kubernetes event/state Collector Deployment.

For local kind and Minikube contexts the command enables kubelet TLS verification bypass
for the self-signed local kubelet only. For other clusters it remains disabled. To force
that local-only behavior, add `--insecure-kubelet`.

You can run the stages separately:

```powershell
npm run cluster:add -- --endpoint http://host.docker.internal:3001
npm run cluster:install
npm run cluster:verify
```

## 4. What verification proves

Verification checks:

- the configured Kubernetes API is reachable;
- BookNest backend pods exist under the registered namespace/label;
- the collector DaemonSet desired count equals its ready count;
- the event collector has its desired ready replicas;
- collectors are not repeatedly reporting export failures;
- the cluster can reach Faultline ingestion;
- all Faultline services are ready;
- a temporary pod's `FAULTLINE_ONBOARDING_TEST` log is queryable from ClickHouse; and
- `database connection refused` became a `DATABASE_CONNECTIVITY` anomaly visible in
  an `APPLICATION_DEPENDENCY_FAILURE` incident.

Successful output ends with:

```text
FAULTLINE ONBOARDING COMPLETE

Cluster: BookNest local cluster (booknest-development)
BookNest: 1 pod(s) discovered in default
Collector: Healthy
Faultline ingestion: Healthy
Processor: Healthy
Telemetry storage: Healthy
First log: Received
Log classification: DATABASE_CONNECTIVITY
Kubernetes → Faultline: CONNECTED
```

This proves the real path rather than merely checking that a collector pod is running.

## Day-two commands

Check Faultline and recent logs:

```powershell
npm run preflight
Invoke-RestMethod http://127.0.0.1:3000/incidents
$start = (Get-Date).AddMinutes(-10).ToUniversalTime().ToString('o')
$end = (Get-Date).AddMinutes(1).ToUniversalTime().ToString('o')
Invoke-RestMethod "http://127.0.0.1:3000/telemetry/logs?clusterId=booknest-development&startTime=$([uri]::EscapeDataString($start))&endTime=$([uri]::EscapeDataString($end))&workload=booknest-backend"
```

Inspect collectors and local runtime output:

```powershell
kubectl -n faultline-system get pods,daemonsets,deployments
kubectl -n faultline-system logs daemonset/faultline-collector-logs --since=5m
Get-Content .local/faultline.log -Tail 100
```

Restart or stop Faultline (normal stop retains all Docker volumes):

```powershell
npm run faultline:restart
npm run faultline:stop
```

Remove only the temporary verification Deployment:

```powershell
npm run onboarding:test:cleanup
```

Uninstall collectors explicitly. This removes `faultline-system`; it does not change
BookNest or delete the separate `faultline-onboarding` namespace:

```powershell
npm run cluster:uninstall
```

Normal stop and collector uninstall retain PostgreSQL/ClickHouse data. To deliberately
delete all local Faultline infrastructure volumes:

```powershell
npm run dev:reset -- --confirm-destroy-data
```

## Remote/private cluster limitations

`host.docker.internal` and `host.minikube.internal` are local-cluster conveniences and
usually do not resolve from remote clusters. Supply an ingestion endpoint routable from
cluster nodes. Production remote onboarding should expose ingestion over HTTPS with a
CA-trusted certificate and a network policy/firewall that permits outbound collector
traffic. Faultline never requires inbound access to the Kubernetes API.

This repository currently provides development shared-token authentication. Treat the
generated token as local-only; a remote production deployment needs the platform's
production cluster credential implementation and secure endpoint provisioning. Nodes
with nonstandard container-log paths require a matching collector mount/configuration.
