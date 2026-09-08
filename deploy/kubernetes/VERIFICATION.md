# Live Kubernetes verification

This document records the earlier log/event iteration. The subsequent metrics and
workload-state extension, including updated RBAC and 36 passing tests, is recorded in
[Metrics verification](METRICS-VERIFICATION.md).

Completed successfully on **2026-09-08** against a real, two-node kind cluster.
The cluster is left running with kubectl context `kind-faultline`.

## Environment

- Docker Desktop 27.5.1, kind 0.27.0, Kubernetes 1.32.2, kubectl 1.31.4.
- Collector Contrib 0.147.0: one log collector on each Linux node and one event collector.
- Faultline's development ingestion and processor run together in one container with
  the existing in-memory queue. The demo runs as a separate Kubernetes Deployment.
- Both nodes and all four Faultline/Collector pods are Ready. See [cluster state](evidence/cluster.json).
- The kind download passed its SHA-256 checksum, the Faultline Docker image built,
  and `npm run validate:collector` passed using the actual Collector binary.

## Real telemetry evidence

[Initial pipeline evidence](evidence/live-pipeline.json) and
[post-recovery evidence](evidence/post-recovery-pipeline.json) contain actual processor
results from Kubernetes container logs and the Kubernetes Event API, not synthetic OTLP requests.

Verified stdout and stderr preserve the demo message, stream, original nanosecond timestamp,
cluster, namespace, pod, container, node, workload, service, pod UID and container ID.
A real `Started` Kubernetes Event reached the processor with its involved pod context.
Plain-text demo logs have severity `unknown`; their stream remains available.
`npm run verify:kubernetes` succeeded before and after the outage test.

## Outage and recovery

Faultline was scaled to zero while the collectors and demo kept running. After a
30-second observation period, Faultline was restored. [Captured evidence](evidence/resilience.json)
shows all six recovery assertions passed:

- The same demo pod kept emitting messages without restarting during the outage.
- The worker log collector queue grew from 0 to 6 requests; the event queue grew to 1.
- Fourteen retry log entries were observed across the log collectors.
- Both queues drained to zero after recovery.
- A log written during the outage subsequently reached the processor.
- Both monitored collector health endpoints stayed available throughout.

The log collector's sent counter increased from 137 to 185, and the event collector's
from 6 to 17 by the recovery snapshot. Internal metrics show receipt and export separately.
The demo was deliberately restarted after this test to generate fresh startup events;
that restart was not caused by Faultline's outage.

## RBAC and regression checks

[Live authorization checks](evidence/rbac.json) confirmed required pod/namespace/event
reads and denied Secret access, pod deletion, event creation and node reads.
The existing regression suite has 26 passing tests and typecheck passes; no telemetry
application changes were needed to make the live verification succeed.

## Operational notes

Earlier download timeouts were resolved after connectivity improved. Docker's
multi-platform image import failed with `content digest ... not found`; explicitly
importing Linux/AMD64 images into each node fixed it. The [deployment guide](README.md)
includes the fallback.

The default kubeconfig now selects `kind-faultline`; an additional copy is in
`.local/kubeconfig`. The downloaded executable is `.local/kind.exe`. `.local` is ignored
by Git. The development token lives in the Kubernetes Secret and is absent from these
verification artifacts. Temporary health/metrics port-forwards have been stopped.

To inspect the running pipeline:

```powershell
kubectl --context kind-faultline -n faultline-system get pods
kubectl --context kind-faultline -n faultline-system logs deployment/faultline-dev --tail=20
```

For another full verification later, restart the demo first to generate a fresh
Kubernetes Event within the verifier's five-minute window, then run `npm run verify:kubernetes`.
This test establishes development integration and bounded outage recovery, not durability
or production readiness.
