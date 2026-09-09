import {
  RESOURCE_STATE,
  type ResourceStateStore,
} from './resource-state/resource-state';
import {
  Inject,
  Injectable,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ApplicationLogger } from '@faultline/platform';
import {
  QUEUE,
  Queue,
  QueueMessage,
  QueueSubscription,
} from '@faultline/queue';
import {
  RAW_TELEMETRY_TOPIC,
  ingestedTelemetryEventSchema,
} from '@faultline/telemetry';
import { RULE_ENGINE, type RuleEngine } from './rules/contracts';
import {
  INCIDENT_CORRELATOR,
  type IncidentChange,
  type IncidentCorrelator,
} from './correlation/contracts';
import {
  PROCESSING_LEDGER,
  type ProcessingLedger,
} from './infrastructure/redis';
import {
  STATISTICAL_DETECTOR,
  type StatisticalDetector,
} from './statistical/contracts';

@Injectable()
export class TelemetryConsumer implements OnModuleInit, OnModuleDestroy {
  private subscription?: QueueSubscription;
  private stateSweep?: NodeJS.Timeout;
  constructor(
    @Inject(QUEUE) private readonly queue: Queue,
    private readonly logger: ApplicationLogger,
    @Inject(RESOURCE_STATE) private readonly state: ResourceStateStore,
    @Optional() @Inject(RULE_ENGINE) private readonly rules?: RuleEngine,
    @Optional()
    @Inject(INCIDENT_CORRELATOR)
    private readonly correlator?: IncidentCorrelator,
    @Optional()
    @Inject(PROCESSING_LEDGER)
    private readonly ledger?: ProcessingLedger,
    @Optional()
    @Inject(STATISTICAL_DETECTOR)
    private readonly statistical?: StatisticalDetector,
  ) {}
  async onModuleInit() {
    this.stateSweep = setInterval(() => {
      void this.state.sweep();
    }, 30_000);
    this.stateSweep.unref();
    this.subscription = await this.queue.subscribe(
      RAW_TELEMETRY_TOPIC,
      async (message) => {
        await this.process(message);
      },
    );
  }
  async onModuleDestroy() {
    if (this.stateSweep) clearInterval(this.stateSweep);
    await this.subscription?.close();
  }
  async process(message: QueueMessage) {
    const parsed = ingestedTelemetryEventSchema.safeParse(message.payload);
    if (!parsed.success || parsed.data.id !== message.id) {
      this.logger.warn({
        event: 'processor_event_rejected',
        status: 'rejected',
      });
      throw new Error(
        'Malformed internal telemetry event or unsupported telemetry type',
      );
    }
    const event = parsed.data;
    const redelivery = Number(message.headers?.deliveryAttempt ?? 1) > 1;
    if (this.ledger && !(await this.ledger.begin(event.id, redelivery))) {
      this.logger.log({
        event: 'processor_duplicate_ignored',
        event_id: event.id,
      });
      return;
    }
    try {
      const processed = {
        ...event,
        processedAt: new Date().toISOString(),
        processor: 'faultline-processor',
        status: 'processed' as const,
      };
      this.logger.log({
        event: 'telemetry_processed',
        event_id: processed.id,
        type:
          processed.kind === 'kubernetes'
            ? 'KUBERNETES_EVENT'
            : processed.kind.toUpperCase(),
        cluster_id: processed.clusterId,
        service: processed.service,
        namespace: processed.namespace,
        pod: processed.pod,
        container: processed.container,
        node: processed.node,
        workload: processed.workload,
        pod_uid: processed.attributes['k8s.pod.uid'],
        container_id: processed.attributes['container.id'],
        ...(processed.kind === 'log'
          ? { severity: processed.level, stream: processed.stream }
          : {}),
        ...(processed.kind === 'kubernetes'
          ? { reason: processed.reason, event_type: processed.type }
          : {}),
        ...(processed.kind === 'metric'
          ? {
              metric: processed.name,
              value: processed.value,
              unit: processed.unit,
              category: processed.category,
              direction: processed.attributes.direction,
              interface: processed.attributes.interface,
            }
          : {}),
        // Only the explicitly opted-in sample workload exposes message text for local verification.
        ...(processed.namespace === 'faultline-demo' &&
        process.env.FAULTLINE_LOG_DEMO_MESSAGES === 'true' &&
        process.env.NODE_ENV === 'development' &&
        processed.kind !== 'metric'
          ? { telemetry_message: processed.message }
          : {}),
        timestamp: processed.timestamp,
        ingestedAt: processed.ingestedAt,
        processedAt: processed.processedAt,
        processor: processed.processor,
        status: processed.status,
      });
      const state =
        processed.kind === 'metric'
          ? await this.state.update(processed)
          : await this.state.findForTelemetry(processed);
      if (state)
        this.logger.log({ event: 'resource_state_updated', resource: state });
      // Deterministic rules and statistical detection are peers: both read the same
      // event and the same resource state, neither can veto the other, and both feed
      // one correlation engine. A statistical failure must not lose a rule anomaly, so
      // detection is settled independently and only then merged.
      const [deterministic, statistical] = await Promise.all([
        Promise.resolve(this.rules?.evaluate(processed, state) ?? []),
        this.detectStatistically(processed, state),
      ]);
      for (const anomaly of [...deterministic, ...statistical]) {
        this.logger.log({
          event:
            anomaly.status === 'RESOLVED'
              ? 'anomaly_resolved'
              : 'anomaly_detected',
          anomaly_id: anomaly.anomalyId,
          lifecycle: anomaly.status,
          rule_id: anomaly.ruleId,
          classification: anomaly.classification,
          source: anomaly.source,
          severity: anomaly.severity,
          anomaly_score: anomaly.anomalyScore,
          confidence: anomaly.confidence,
          baseline: anomaly.baseline,
          cluster: anomaly.clusterId,
          namespace: anomaly.affectedResource.namespace,
          workload: anomaly.affectedResource.workload,
          pod: anomaly.affectedResource.pod,
          container: anomaly.affectedResource.container,
          node: anomaly.affectedResource.node,
          summary: anomaly.summary,
          evidence: anomaly.evidence,
          timestamp: anomaly.timestamp,
        });
        await this.publishOperationalEvent(
          anomaly.status === 'RESOLVED'
            ? 'anomalies.resolved'
            : 'anomalies.detected',
          `${anomaly.anomalyId}:${anomaly.status}:${anomaly.timestamp}`,
          anomaly,
        );
        const change = await this.correlator?.correlate(anomaly);
        if (change) {
          this.logIncident(change);
          await this.publishIncident(change);
        }
      }
      for (const change of (await this.correlator?.advance(
        processed.timestamp,
      )) ?? []) {
        this.logIncident(change);
        await this.publishIncident(change);
      }
      await this.rules?.commit?.();
      await this.statistical?.commit?.();
      await this.ledger?.complete(event.id);
      return processed;
    } catch {
      await this.rules?.rollback?.();
      await this.statistical?.rollback?.();
      await this.ledger?.release(event.id);
      this.logger.error({
        event: 'processor_failed',
        event_id: event.id,
        status: 'failed',
      });
      throw new Error('Telemetry processing failed');
    }
  }

  /**
   * Statistical detection is best-effort.
   *
   * It depends on baselines, which depend on telemetry history. If that lookup fails,
   * the event is still processed and deterministic rules still fire: losing "this is
   * unusual" is acceptable, losing "Kubernetes killed this container" is not.
   */
  private async detectStatistically(
    event: Parameters<NonNullable<typeof this.statistical>['detect']>[0],
    state: Parameters<NonNullable<typeof this.statistical>['detect']>[1],
  ) {
    if (!this.statistical) return [];
    try {
      return await this.statistical.detect(event, state);
    } catch {
      this.logger.warn({
        event: 'statistical_detection_failed',
        event_id: event.id,
      });
      return [];
    }
  }

  private logIncident(change: IncidentChange): void {
    const incident = change.incident;
    this.logger.log({
      event:
        change.type === 'CREATED'
          ? 'incident_created'
          : change.type === 'RESOLVED'
            ? 'incident_resolved'
            : 'incident_updated',
      incident_id: incident.id,
      lifecycle: incident.status,
      classification: incident.classification,
      severity: incident.severity,
      confidence: incident.confidence,
      // Makes it obvious at a glance whether history contributed to this incident.
      statistical_anomalies: incident.anomalies.filter(
        (item) => item.source === 'STATISTICAL',
      ).length,
      cluster: incident.clusterId,
      namespace: incident.namespace,
      workload: incident.primaryResource.workload,
      node: incident.primaryResource.node,
      affected_resources: incident.affectedResources.length,
      anomalies: incident.anomalies.length,
      first_seen: incident.firstSeen,
      last_seen: incident.lastSeen,
      resolved_at: incident.resolvedAt,
    });
  }

  private async publishIncident(change: IncidentChange): Promise<void> {
    await this.publishOperationalEvent(
      'incidents.updated',
      `${change.incident.id}:${change.type}:${change.incident.lastSeen}:${change.incident.resolvedAt ?? ''}`,
      change,
    );
  }

  private async publishOperationalEvent(
    topic: string,
    id: string,
    payload: unknown,
  ): Promise<void> {
    // Unit-test adapter intentionally requires subscribers; production JetStream persists without one.
    if (this.queue.deliveryGuarantee !== 'at-least-once') return;
    await this.queue.publish(topic, {
      id,
      payload,
      headers: {
        eventType: topic,
        schemaVersion: '1',
        source: 'faultline-processor',
      },
    });
  }
}
