# Metrics iteration: live verification

Verified on 2026-09-08 against the existing two-node `kind-faultline` cluster
(Kubernetes 1.32.2, Collector Contrib 0.147.0). This extends the historical
[log/event verification](VERIFICATION.md).

- `npm test`: **36 tests passed**, including the shared build.
- `npm run validate:collector`: both final Collector configurations accepted by the pinned binary.
- Updated development Docker image built and loaded into both kind nodes.
- `npm run verify:metrics`: passed against real Kubernetes telemetry.
- Existing `verify:kubernetes` log/event path passed after the application update.
- Final cluster status: all four Faultline/Collector pods and the demo pod are Ready.

## Evidence

| Artifact                                                                        | What it proves                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [metrics-live.json](evidence/metrics-live.json)                                 | Current pod UID and Kubernetes spec/status alongside processor resource state; CPU/memory usage and limits, readiness, restarts, running state; all 15 metric coverage checks passed |
| [readiness-failed.json](evidence/readiness-failed.json)                         | The actual demo readiness probe failed; processor reported false while the container remained running                                                                                |
| [restart-change.json](evidence/restart-change.json)                             | A deliberate single container restart increased the count; previous/current/delta and Kubernetes' last termination reason were retained                                              |
| [memory-growth.json](evidence/memory-growth.json)                               | Observed memory-usage samples from the bounded demo, with minimum/maximum bytes                                                                                                      |
| [metrics-log-event-regression.json](evidence/metrics-log-event-regression.json) | Enriched stdout, stderr, and a real Kubernetes Event still reach the processor                                                                                                       |

The final container view identifies `telemetry-demo-cff745c9b-c9pqw/demo` in
`faultline-demo`, Deployment `telemetry-demo`, with CPU limit **0.25 cores**,
memory limit **201326592 bytes (192 MiB)**, restart count **2**, readiness **true**,
and state **running**. CPU/memory usage are live samples, not fixed expected values.
The two total restarts were explicitly requested during verification, each through a
consumed one-shot marker. Readiness was restored after its test.

The path exercised was Kubernetes kubelet/API → Collector → authenticated batch
ingestion → the existing development queue → processor → in-memory resource state.
No synthetic HTTP fixtures were used to generate these live artifacts. Unit/HTTP
integration tests separately exercise malformed inputs and ordering edge cases.

ReplicaSet-name heuristics failed to resolve this demo's Deployment correctly, so
both metadata processors now use actual read-only ReplicaSet owner-reference lookups.
The final metric verifier checks the resolved workload as well as the current pod UID,
readiness and restart count against Kubernetes.

The base manifests verify kubelet TLS. For this dedicated kind cluster, the DaemonSet
uses the documented local override for its self-signed kubelet serving certificate.
The existing shared development token and process-local queue remain development-only.
State is bounded and ephemeral (120-second field TTL, 10,000 resource capacity);
there is no production queue, storage, classification, incident generation or alerting.
