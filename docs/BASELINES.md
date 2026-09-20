# Baselines and statistical detection

Faultline detects abnormal behaviour that Kubernetes never labels as a failure: memory
creeping upward, an unexplained CPU spike, an error rate three times its usual share, a
p95 latency that quadrupled. None of these trip a threshold. All of them are unusual
_for that workload_.

```
ClickHouse
     │
Historical Telemetry
     │
     ▼
Baseline Engine ──────► Expected Behaviour (PostgreSQL)
                                  │
Kubernetes → Telemetry → Processor│
                            ┌─────┴─────┐
                            │           │
                 Deterministic Rules   Statistical Detector
                            │           │
                            └─────┬─────┘
                                  ▼
                               Anomaly
                                  ▼
                            Correlation
                                  ▼
                               Incident
                                  ▼
                             PostgreSQL
```

## Responsibilities

| Component                | Answers                                            |
| ------------------------ | -------------------------------------------------- |
| **Rule engine**          | Is a known failure condition true right now?       |
| **Baseline engine**      | What does this workload normally do?               |
| **Statistical detector** | Is current behaviour unusual against that history? |
| **Correlation engine**   | Which signals describe one operational incident?   |

The rule engine and the statistical detector are peers. Neither can veto the other, and
both feed the same correlation engine — there is no second incident system.

### Thresholds are not anomalies

`memory > 95% of limit` is a rule: it is true or false regardless of history, and it
belongs to the deterministic engine. `memory normally sits at 35% and is now at 70%` is a
statistical finding: it names no threshold and says everything about this workload's own
past. Both coexist, and both can fire on the same container in the same minute.

## The baseline domain

`@faultline/baselines` holds the whole domain and depends on nothing but
`@faultline/incidents`. It never imports a ClickHouse client. History is read through the
`HistoricalTelemetryQuery` port and baselines are written through `BaselineRepository`,
so the engine can be tested, and later re-pointed, without touching detection code.

A `MetricBaseline` records a cluster, namespace, workload, resource type, metric, window
and season, plus `sampleCount`, `mean`, `min`, `max`, `standardDeviation`, `p50`, `p95`,
`p99`, `excludedRanges` and `updatedAt`.

### Scoping

Baselines are always per **cluster + namespace + workload + metric**. Comparing
`payment-api` against `search-api` would be meaningless, so there is no global baseline
and no cross-workload aggregate anywhere in the design.

### Seasons

Every key, row and API response carries a `season`, which is `{ kind: 'all' }` today.
That is the one piece of future-proofing the design commits to: adding "Monday 09:00
differs from Sunday 03:00" later becomes a new season kind and extra rows, not a
migration, because nothing assumes a single average describes every hour.

## Signals

The catalog in `@faultline/baselines` is the single place that says which signals exist,
how their samples are derived, and which technique suits each. The refresh job and the
detector both read it, which is what stops the two halves from drifting apart.

| Baseline metric                                           | Source                           | Technique  | Classification          | Window  |
| --------------------------------------------------------- | -------------------------------- | ---------- | ----------------------- | ------- |
| `k8s.container.cpu.usage`                                 | gauge                            | z-score    | `CPU_USAGE_ANOMALY`     | fast    |
| `k8s.container.memory.usage`                              | gauge                            | z-score    | `MEMORY_USAGE_ANOMALY`  | default |
| `k8s.container.memory.usage`                              | gauge                            | trend      | `MEMORY_GROWTH_ANOMALY` | default |
| `faultline.container.memory.utilization`                  | usage ÷ limit per bucket         | z-score    | `MEMORY_USAGE_ANOMALY`  | default |
| `faultline.container.restart_rate`                        | restart counter, restarts/hour   | z-score    | `RESTART_RATE_ANOMALY`  | default |
| `faultline.pod.network.receive_rate`                      | network counter, bytes/second    | z-score    | `NETWORK_RX_ANOMALY`    | fast    |
| `faultline.pod.network.transmit_rate`                     | network counter, bytes/second    | z-score    | `NETWORK_TX_ANOMALY`    | fast    |
| `faultline.workload.log_error_rate`                       | error logs ÷ all logs per bucket | z-score    | `ERROR_RATE_ANOMALY`    | fast    |
| `http.server.duration`, `request.duration`, `api.latency` | gauge distribution               | percentile | `LATENCY_ANOMALY`       | fast    |

Names beginning with `faultline.` are derived signals; the rest are ingested metric names.

A classification can only fire when its telemetry exists. If a workload exports no
latency metric, no latency baseline is computed, so no latency anomaly is possible.
**Nothing is inferred from logs**: latency is never estimated from log text, and the
error rate is derived only from structured log severity.

### Rates and counter resets

Restart counts and network byte totals are cumulative counters that return to zero when a
container restarts. Both the ClickHouse summary and the live detector treat a negative
delta as a restart and count from zero instead, so a restart can never register as a
large negative rate that quietly drags the baseline down.

### Error rate is a share, not a count

A bucket's error rate is `error logs ÷ all logs`. A workload that simply logs more must
not read as a workload that is failing. This is an **operational** signal: a raised error
rate says the workload is behaving unusually, not that users are seeing failures.

## Techniques

Explainable statistics only. Every number can be shown to an operator and checked by
hand — a detection nobody can explain is not actionable during an incident.

- **z-score** — distance from the mean in standard deviations, for signals with a
  reasonably stable centre.
- **Percentile ratio** — the current p95 as a multiple of the normal p95, for
  long-tailed signals such as latency, where "three times the usual p95" is more honest
  than a z-score over a tail.
- **Rolling average deviation** — gauges are compared using the rolling mean of the live
  window rather than the newest sample, so one spike cannot open an anomaly.
- **Trend** — least-squares fit for sustained growth (below).

### Guarding against near-zero spread

A metric that sat at exactly 400 MiB all week has almost no standard deviation, and a
naive z-score would put a move to 500 MiB in the hundreds. The deviation used is
therefore `max(standardDeviation, |mean| × STATISTICAL_DEVIATION_RELATIVE_FLOOR)`, which
keeps scores finite and comparable across metrics.

### Memory growth

A rise counts only when all three hold: the least-squares fit is good
(`rSquared ≥ 0.7`), the climb is mostly monotonic (`≥ 0.7` of steps do not decrease), and
the total change clears `STATISTICAL_GROWTH_MIN_PERCENT`. A sawtooth ends higher than it
began and has a positive slope, but is not a trend.

The classification is `MEMORY_GROWTH_ANOMALY`, not "memory leak". Faultline can see the
shape of the curve; it cannot see the cause.

## Score and confidence

They are separate on purpose, and the anomaly carries both:

- **`anomalyScore`** — distance from expected behaviour. Its unit depends on the
  technique, so every anomaly's baseline evidence records a `scoreKind`:
  `standard-deviations`, `percentile-multiple`, or `growth-multiple`.
- **`confidence`** — how much Faultline trusts the finding, from baseline depth, how
  long the deviation has persisted, and how many live samples backed the comparison.

A workload can be wildly outside its baseline (high score) while the baseline itself is
thin and barely trustworthy (low confidence). Collapsing the two into one number would
hide exactly that distinction.

```
classification: MEMORY_USAGE_ANOMALY
source:         STATISTICAL
anomalyScore:   3.8            (standard deviations)
confidence:     0.88
baseline:       mean 410 MiB, p95 455 MiB, 1440 samples over 24h
current:        520 MiB  (+26.8%)
```

## Severity

Derived from magnitude, duration, affected replicas, baseline confidence, and how many
other statistical anomalies are open on the same workload. A short single-replica
deviation is **capped at WARNING** no matter how large the score: one container spiking
for a minute is not the same operational event as three replicas degrading for a quarter
of an hour, and paging as though it were is how statistical detection loses an operator's
trust.

## Noise control

Four safeguards apply before anything reaches correlation:

| Safeguard       | Setting                                 | Effect                                                                    |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Minimum samples | `STATISTICAL_MIN_CURRENT_SAMPLES`       | No comparison without enough live samples                                 |
| Duration        | `STATISTICAL_MIN_CONSECUTIVE_WINDOWS`   | Abnormal evaluations required before opening                              |
| Hysteresis      | `STATISTICAL_Z_SCORE_RESOLVE_THRESHOLD` | Leaving is harder than entering, so a metric on the line cannot oscillate |
| Cooldown        | `STATISTICAL_COOLDOWN_MS`               | Quiet period after a resolve                                              |

Plus deduplication: one open anomaly per classification and resource, updated in place
as ACTIVE rather than reopened. Memory usage and memory utilization both speak to
`MEMORY_USAGE_ANOMALY`, and the stronger of the two is reported so one deviation never
opens two anomalies.

Between the trigger and resolve thresholds neither counter advances: the signal is
neither clearly abnormal nor clearly recovered, so its current verdict simply holds.

**Known limitation.** An open anomaly is only resolved by evidence that the metric came
back. If telemetry for a workload stops entirely, its statistical anomalies stay open,
and incident stabilization in the correlation engine is what eventually closes the
incident.

## Baseline refresh

Refresh runs in `apps/storage` on `BASELINE_REFRESH_INTERVAL_MS`, because that service
already owns the ClickHouse connection holding telemetry history. Keeping derivation
there is what lets the processor have **no ClickHouse dependency at all**: it reads
finished baselines from PostgreSQL and keeps detecting deviations even when history is
down.

Refresh is scheduled, not incremental. Recomputing a 24-hour distribution for every
arriving sample would cost far more than it could be worth, and a baseline that moves
within one interval was never a baseline. A failed refresh leaves the previous baselines
in place; detection continues against slightly older expected behaviour rather than
stopping. Workloads that stop reporting age out after `BASELINE_STALE_AFTER_MS`.

Summaries — quantiles, standard deviation, per-bucket rates — are computed **inside**
ClickHouse. Shipping a day of raw samples to Node to average them would be slower by
orders of magnitude and would put the size of a workload's history into the process's
memory budget.

## Insufficient history

Below `BASELINE_MIN_SAMPLES`, a baseline is stored with status `BASELINE_NOT_READY` and
no statistics, and the detector raises nothing for it. A freshly deployed workload must
not have its first ten minutes treated as a law of nature. The row is still written, with
its `sampleCount`, so `GET /baselines` explains why Faultline is silent.

## Polluted baselines

A baseline computed straight from history would happily learn that a two-hour outage is
normal, and then stay quiet the next time it happens. Before summarizing, the engine
subtracts:

- windows of HIGH and CRITICAL incidents for that workload, read from PostgreSQL
- windows around Kubernetes warning events — `OOMKilling`, `BackOff`, `CrashLoopBackOff`,
  `Evicted`, `FailedScheduling`, `Unhealthy`, `NodeNotReady` — padded by
  `BASELINE_DISRUPTION_PADDING_MS`

Overlapping ranges are merged, so a crash loop producing hundreds of events costs one
exclusion range rather than hundreds.

**Known limitations.** This is coarse on purpose. Degradation that never produced an
incident or a Kubernetes warning — a slow leak, a quiet latency regression — is still
learned as normal. An excluded stretch also shrinks the sample count, so a workload that
spent most of the window unhealthy may fall back to `BASELINE_NOT_READY` rather than
producing a cleaner baseline. Both are safer failure modes than the alternative, and both
are visible: every baseline row reports `excludedRanges` and `sampleCount`.

Set `BASELINE_EXCLUDE_DISRUPTED_PERIODS=false` to disable exclusion explicitly.

## Correlation

Statistical anomalies use the same `Anomaly` shape as deterministic ones, with a
`source` of `STATISTICAL`, and flow through the existing correlation engine. Signal
families decide what belongs together:

| Family             | Classifications                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Memory             | `HIGH_MEMORY_UTILIZATION`, `OOM_KILLED`, `MEMORY_USAGE_ANOMALY`, `MEMORY_GROWTH_ANOMALY` |
| Availability       | `CRASH_LOOP`, `POD_NOT_READY`, `DEPLOYMENT_DEGRADED`, `RESTART_RATE_ANOMALY`             |
| Application health | `ERROR_RATE_ANOMALY`, `LATENCY_ANOMALY`                                                  |
| Saturation         | `HIGH_CPU_UTILIZATION`, `CPU_USAGE_ANOMALY`, `NETWORK_RX_ANOMALY`, `NETWORK_TX_ANOMALY`  |

So a `MEMORY_GROWTH_ANOMALY` seen twenty minutes before an `OOM_KILLED` strengthens one
`MEMORY_EXHAUSTION` incident rather than opening a second one, and raises its confidence:
the workload was already drifting away from its own normal before Kubernetes acted.
`ERROR_RATE_ANOMALY` together with `LATENCY_ANOMALY` produces the new
`APPLICATION_DEGRADATION` classification — the workload still runs, but is serving worse
than it normally does.

Classification order matters: deterministic failures are checked first, so a
crash-looping workload is reported as crashing even though it is also, incidentally,
serving errors.

## Incident evidence

Baseline numbers travel with the anomaly onto the incident, as `baseline`-typed evidence
entries, and every evidence row and timeline entry records its `source`. An operator
reading an incident sees:

```
Incident: Application Degradation        confidence 0.85

  STATISTICAL  Request latency p95 is 740 ms against a normal 190 ms
               baseline: p95 190 ms, p99 260 ms, 3600 samples over 1h
  STATISTICAL  Log error rate is 7.3% against a normal 0.8%
               baseline: mean 0.8%, sd 0.4%, 720 samples over 1h
  Workload:    checkout-api
```

## API

`GET /baselines` — filters: `clusterId`, `namespace`, `workload`, `metricName`,
`window`, `status`, `limit`. Cluster scoping comes from the resolved
`TELEMETRY_QUERY_CLUSTER_SCOPE`, never from the query string, exactly as for telemetry
reads, so one organization cannot read another's baselines.

`GET /baselines/:resourceId/:metricName` — one workload and metric, returning a row per
window. `resourceId` uses the telemetry timeline encoding
(`workload:<cluster>:<namespace>:<name>`), so a link from an incident's affected resource
leads straight here.

Both return `status`, `sampleCount`, `mean`, `p50`, `p95`, `p99`, `standardDeviation`,
`window`, `excludedRanges` and `updatedAt`. `BASELINE_NOT_READY` rows are returned with
their sample count and no statistics, which answers the equally common question of why
Faultline said nothing at all. These endpoints are for debugging and validation; there is
no visualization.

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/baselines?namespace=payments&status=READY"
Invoke-RestMethod "http://127.0.0.1:3000/baselines/workload:production-eu:payments:payment-api/k8s.container.memory.usage"
```

## Storage boundaries

Baselines are derived control-plane state: one small row per workload, metric and
window, recomputable from ClickHouse at any time. They live in PostgreSQL beside
incidents (`metric_baselines`, migration `0002`) rather than in the telemetry store,
which is what allows the processor to keep detecting while ClickHouse is unavailable.
The detector's rolling sample windows and hysteresis counters are ephemeral operational
state and live in Redis, alongside the deterministic rule engine's.

| Store          | Holds                                                  |
| -------------- | ------------------------------------------------------ |
| **ClickHouse** | Raw telemetry history that baselines are derived from  |
| **PostgreSQL** | Incidents and derived baselines                        |
| **Redis**      | Sample windows, consecutive-window counters, cooldowns |

## Configuration

Baseline settings belong to `apps/storage`; detection settings to `apps/processor`.
Defaults are development defaults — every deployment sets its own.

| Variable                                  | Default     | Meaning                                       |
| ----------------------------------------- | ----------- | --------------------------------------------- |
| `BASELINE_DEFAULT_WINDOW`                 | `24h`       | Window for slow signals; `1h`/`6h`/`24h`/`7d` |
| `BASELINE_FAST_WINDOW`                    | `1h`        | Window for latency and error rate             |
| `BASELINE_MIN_SAMPLES`                    | `60`        | Below this, `BASELINE_NOT_READY`              |
| `BASELINE_BUCKET_MS`                      | `60000`     | Bucket width for rates and ratios             |
| `BASELINE_REFRESH_INTERVAL_MS`            | `900000`    | Refresh cadence                               |
| `BASELINE_MAX_TARGETS`                    | `200`       | Workloads refreshed per cycle                 |
| `BASELINE_EXCLUDE_DISRUPTED_PERIODS`      | `true`      | Remove known-bad periods before computing     |
| `BASELINE_DISRUPTION_PADDING_MS`          | `300000`    | Padding either side of a disruption marker    |
| `BASELINE_STALE_AFTER_MS`                 | `604800000` | Age out baselines for departed workloads      |
| `BASELINE_CACHE_TTL_MS`                   | `60000`     | Detector's baseline cache (processor)         |
| `STATISTICAL_DETECTION_ENABLED`           | `true`      | Master switch                                 |
| `STATISTICAL_EVALUATION_WINDOW_MS`        | `900000`    | Rolling window of live samples                |
| `STATISTICAL_MIN_CURRENT_SAMPLES`         | `5`         | Live samples before comparing                 |
| `STATISTICAL_Z_SCORE_THRESHOLD`           | `3`         | Standard deviations that count as a deviation |
| `STATISTICAL_Z_SCORE_RESOLVE_THRESHOLD`   | `2`         | Must be strictly lower; validated at startup  |
| `STATISTICAL_PERCENTILE_RATIO_THRESHOLD`  | `2`         | Multiple of baseline p95 for latency          |
| `STATISTICAL_MIN_CONSECUTIVE_WINDOWS`     | `3`         | Abnormal evaluations before opening           |
| `STATISTICAL_RESOLVE_CONSECUTIVE_WINDOWS` | `3`         | Normal evaluations before resolving           |
| `STATISTICAL_COOLDOWN_MS`                 | `600000`    | Quiet period after a resolve                  |
| `STATISTICAL_DEVIATION_RELATIVE_FLOOR`    | `0.05`      | Relative floor on baseline spread             |
| `STATISTICAL_GROWTH_MIN_PERCENT`          | `25`        | Total rise that counts as growth              |
| `STATISTICAL_GROWTH_MIN_R_SQUARED`        | `0.7`       | Fit quality for a sustained climb             |

## Tests

`npm test` covers the whole path with no infrastructure: statistics primitives, insufficient
history, normal behaviour, CPU and memory deviation, sustained growth versus a sawtooth,
error-rate spikes versus a chattier logger, network counter rates and resets, latency
percentiles and absent latency telemetry, deduplication, hysteresis, resolution, cooldown,
severity escalation, redelivery, detector state across a restart, baseline refresh,
staleness, pollution exclusion, API scoping, and the end-to-end scenario:

```
payment-api normal memory → baseline created → memory gradually increases
→ MEMORY_GROWTH_ANOMALY → memory reaches the hard threshold
→ HIGH_MEMORY_UTILIZATION → container OOMKilled → correlation
→ one MEMORY_EXHAUSTION incident retaining both statistical and deterministic evidence
```

`npm run test:clickhouse` additionally verifies that gauge summaries, derived utilization
ratios, counter rates, log error rates and disruption windows are computed correctly by
ClickHouse itself.
