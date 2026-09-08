import { createHash } from 'node:crypto';
import type { Anomaly, AnomalyAffectedResource } from '@faultline/incidents';
import type { AnomalyThresholds } from '@faultline/platform';
import type { TelemetryEvent } from '@faultline/telemetry';
import type { ResourceState } from '../resource-state/resource-state';
import type {
  AnomalyRule,
  ConditionObservation,
  RuleContext,
  RuleEngine,
} from './contracts';
import {
  resourceFromEvent,
  resourceKey,
  sameWorkload,
  telemetryEvidence,
} from './helpers';

interface ConditionState {
  active: boolean;
  count: number;
  since: number;
  last: number;
}
interface ActiveState {
  anomaly: Anomaly;
  confirmations: number;
}
interface RestartSample {
  timestamp: number;
  delta: number;
}

/**
 * Process-local deterministic evaluation and lifecycle store.
 * It is bounded, event-time aware, and deliberately contains no incident logic.
 */
export class InMemoryRuleEngine implements RuleEngine {
  private readonly seenIds = new Map<string, number>();
  private readonly evidence: TelemetryEvent[] = [];
  private readonly conditions = new Map<string, ConditionState>();
  private readonly active = new Map<string, ActiveState>();
  private readonly restarts = new Map<string, RestartSample[]>();
  private readonly watermarks = new Map<string, number>();

  constructor(
    private readonly rules: readonly AnomalyRule[],
    private readonly thresholds: AnomalyThresholds,
    private readonly historyWindowMs = 5 * 60_000,
    private readonly capacity = 10_000,
  ) {}

  evaluate(event: TelemetryEvent, state?: ResourceState): readonly Anomaly[] {
    if (this.seenIds.has(event.id)) return [];
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) return [];
    const eventResource = resourceFromEvent(event);
    const watermarkKey =
      resourceKey(eventResource) +
      ':' +
      event.kind +
      (event.kind === 'metric' ? ':' + event.name : '');
    const watermark = this.watermarks.get(watermarkKey);
    if (watermark !== undefined && time < watermark) return [];
    this.watermarks.set(watermarkKey, Math.max(watermark ?? time, time));
    this.remember(event, time);
    if (
      event.kind === 'metric' &&
      state?.scope === 'container' &&
      event.name === 'k8s.container.restart_count' &&
      state.restartDelta &&
      state.restartDelta > 0
    ) {
      const key = resourceKey(state);
      const samples = this.restarts.get(key) ?? [];
      samples.push({ timestamp: time, delta: state.restartDelta });
      this.restarts.set(
        key,
        samples.filter(
          (sample) => sample.timestamp >= time - this.historyWindowMs,
        ),
      );
    }
    const context: RuleContext = {
      event,
      state,
      thresholds: this.thresholds,
      observe: (key, condition) => this.observe(key, condition, time),
      recentEvidence: (predicate) =>
        this.evidence.filter(
          (candidate) =>
            Date.parse(candidate.timestamp) >= time - this.historyWindowMs &&
            predicate(candidate),
        ),
      restartIncreaseCount: (resource) =>
        (this.restarts.get(resourceKey(resource)) ?? [])
          .filter((sample) => sample.timestamp >= time - this.historyWindowMs)
          .reduce((total, sample) => total + sample.delta, 0),
    };
    const emitted: Anomaly[] = [];
    for (const rule of this.rules) {
      for (const evaluation of rule.evaluate(context)) {
        const prior = this.active.get(evaluation.dedupeKey);
        if (!evaluation.match) {
          if (!prior) continue;
          const resolved: Anomaly = {
            ...prior.anomaly,
            status: 'RESOLVED',
            timestamp: event.timestamp,
            lastSeen: event.timestamp,
            evidence: [
              ...prior.anomaly.evidence,
              telemetryEvidence(event, 'Condition returned to normal'),
            ].slice(-10),
          };
          this.active.delete(evaluation.dedupeKey);
          emitted.push(resolved);
          continue;
        }
        if (!prior) {
          const opened: Anomaly = {
            anomalyId: createHash('sha256')
              .update(`${evaluation.dedupeKey}:${event.timestamp}`)
              .digest('hex'),
            dedupeKey: evaluation.dedupeKey,
            ruleId: rule.ruleId,
            classification: rule.classification,
            ...evaluation.match,
            clusterId: evaluation.affectedResource.clusterId,
            affectedResource: evaluation.affectedResource,
            timestamp: event.timestamp,
            status: 'OPEN',
            firstSeen: event.timestamp,
            lastSeen: event.timestamp,
          };
          this.active.set(evaluation.dedupeKey, {
            anomaly: opened,
            confirmations: 1,
          });
          emitted.push(opened);
        } else if (prior.confirmations === 1) {
          const active: Anomaly = {
            ...prior.anomaly,
            ...evaluation.match,
            status: 'ACTIVE',
            timestamp: event.timestamp,
            lastSeen: event.timestamp,
            evidence: this.mergeEvidence(
              prior.anomaly.evidence,
              evaluation.match.evidence,
            ),
          };
          this.active.set(evaluation.dedupeKey, {
            anomaly: active,
            confirmations: 2,
          });
          emitted.push(active);
        } else {
          this.active.set(evaluation.dedupeKey, {
            anomaly: {
              ...prior.anomaly,
              ...evaluation.match,
              status: 'ACTIVE',
              timestamp: event.timestamp,
              lastSeen: event.timestamp,
              evidence: this.mergeEvidence(
                prior.anomaly.evidence,
                evaluation.match.evidence,
              ),
            },
            confirmations: prior.confirmations + 1,
          });
        }
      }
    }
    return emitted;
  }

  /** Serializable operational state used by the Redis adapter; rules/configuration stay in code. */
  exportState(): unknown {
    return {
      version: 1,
      seenIds: [...this.seenIds],
      evidence: this.evidence,
      conditions: [...this.conditions],
      active: [...this.active],
      restarts: [...this.restarts],
      watermarks: [...this.watermarks],
    };
  }

  importState(value: unknown): void {
    if (
      !value ||
      typeof value !== 'object' ||
      (value as { version?: unknown }).version !== 1
    )
      return;
    const state = value as {
      seenIds?: [string, number][];
      evidence?: TelemetryEvent[];
      conditions?: [string, ConditionState][];
      active?: [string, ActiveState][];
      restarts?: [string, RestartSample[]][];
      watermarks?: [string, number][];
    };
    this.seenIds.clear();
    this.conditions.clear();
    this.active.clear();
    this.restarts.clear();
    this.watermarks.clear();
    this.evidence.splice(0, this.evidence.length, ...(state.evidence ?? []));
    for (const item of state.seenIds ?? []) this.seenIds.set(...item);
    for (const item of state.conditions ?? []) this.conditions.set(...item);
    for (const item of state.active ?? []) this.active.set(...item);
    for (const item of state.restarts ?? []) this.restarts.set(...item);
    for (const item of state.watermarks ?? []) this.watermarks.set(...item);
  }

  private observe(
    key: string,
    active: boolean,
    time: number,
  ): ConditionObservation {
    const prior = this.conditions.get(key);
    if (prior && time < prior.last)
      return { count: prior.count, durationMs: prior.last - prior.since };
    if (!active) {
      this.conditions.set(key, {
        active: false,
        count: 0,
        since: time,
        last: time,
      });
      return { count: 0, durationMs: 0 };
    }
    const next = prior?.active
      ? { active: true, count: prior.count + 1, since: prior.since, last: time }
      : { active: true, count: 1, since: time, last: time };
    this.conditions.set(key, next);
    return { count: next.count, durationMs: Math.max(0, time - next.since) };
  }

  private remember(event: TelemetryEvent, time: number): void {
    this.seenIds.set(event.id, time);
    this.evidence.push(event);
    const cutoff = time - this.historyWindowMs;
    while (
      this.evidence.length &&
      (this.evidence.length > this.capacity ||
        Date.parse(this.evidence[0]!.timestamp) < cutoff)
    )
      this.evidence.shift();
    for (const [id, timestamp] of this.seenIds) {
      if (this.seenIds.size <= this.capacity && timestamp >= cutoff) break;
      this.seenIds.delete(id);
    }
    while (this.conditions.size > this.capacity)
      this.conditions.delete(this.conditions.keys().next().value!);
    while (this.active.size > this.capacity)
      this.active.delete(this.active.keys().next().value!);
    while (this.watermarks.size > this.capacity)
      this.watermarks.delete(this.watermarks.keys().next().value!);
  }

  private mergeEvidence(
    a: Anomaly['evidence'],
    b: Anomaly['evidence'],
  ): Anomaly['evidence'] {
    const result = [...a];
    for (const evidence of b) {
      const key = [
        evidence.type,
        evidence.eventId,
        evidence.summary,
        evidence.timestamp,
      ].join(':');
      if (
        !result.some(
          (candidate) =>
            [
              candidate.type,
              candidate.eventId,
              candidate.summary,
              candidate.timestamp,
            ].join(':') === key,
        )
      )
        result.push(evidence);
    }
    return result.slice(-10);
  }
}
