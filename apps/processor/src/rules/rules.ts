import type { AnomalyRule, RuleContext, RuleEvaluation } from './contracts';
import {
  anomalyKey,
  calculationEvidence,
  isReason,
  resourceFromEvent,
  resourceFromState,
  sameWorkload,
  stateEvidence,
  telemetryEvidence,
} from './helpers';

abstract class BaseRule implements AnomalyRule {
  abstract readonly ruleId: string;
  abstract readonly classification: AnomalyRule['classification'];
  abstract evaluate(context: RuleContext): readonly RuleEvaluation[];
  protected result(
    resource: ReturnType<typeof resourceFromEvent>,
    match: RuleEvaluation['match'],
  ): RuleEvaluation {
    return {
      dedupeKey: anomalyKey(this.classification, resource),
      affectedResource: resource,
      match,
    };
  }
}

abstract class UtilizationRule extends BaseRule {
  abstract readonly field: 'memoryUtilizationPercent' | 'cpuUtilizationPercent';
  abstract readonly warning: 'memoryWarningPercent' | 'cpuWarningPercent';
  abstract readonly critical: 'memoryCriticalPercent' | 'cpuCriticalPercent';
  abstract readonly label: string;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    const state = context.state;
    if (
      !state ||
      state.scope !== 'container' ||
      context.event.kind !== 'metric'
    )
      return [];
    const relevantName =
      this.field === 'memoryUtilizationPercent'
        ? 'k8s.container.memory.usage'
        : 'k8s.container.cpu.usage';
    if (context.event.name !== relevantName) return [];
    const resource = resourceFromState(state);
    const value = state[this.field];
    if (value === undefined) return [];
    const high = value >= context.thresholds[this.warning];
    const observation = context.observe(
      this.ruleId + ':' + anomalyKey(this.classification, resource),
      high,
    );
    if (!high) return [this.result(resource, null)];
    // Two distinct normalized observations suppress one-sample spikes.
    if (observation.count < 2) return [];
    const critical = value >= context.thresholds[this.critical];
    return [
      this.result(resource, {
        severity: critical ? 'CRITICAL' : 'WARNING',
        confidence: observation.count >= 3 ? 0.95 : 0.85,
        summary: this.label + ' utilization is ' + value.toFixed(2) + '%',
        evidence: [
          calculationEvidence(state, this.label + ' usage divided by limit', {
            utilizationPercent: value,
          }),
        ],
      }),
    ];
  }
}

export class HighMemoryUtilizationRule extends UtilizationRule {
  readonly ruleId = 'resource.high-memory-utilization.v1';
  readonly classification = 'HIGH_MEMORY_UTILIZATION' as const;
  readonly field = 'memoryUtilizationPercent' as const;
  readonly warning = 'memoryWarningPercent' as const;
  readonly critical = 'memoryCriticalPercent' as const;
  readonly label = 'Memory';
}
export class HighCpuUtilizationRule extends UtilizationRule {
  readonly ruleId = 'resource.high-cpu-utilization.v1';
  readonly classification = 'HIGH_CPU_UTILIZATION' as const;
  readonly field = 'cpuUtilizationPercent' as const;
  readonly warning = 'cpuWarningPercent' as const;
  readonly critical = 'cpuCriticalPercent' as const;
  readonly label = 'CPU';
}

export class OomKilledRule extends BaseRule {
  readonly ruleId = 'kubernetes.oom-killed.v1';
  readonly classification = 'OOM_KILLED' as const;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    const state = context.state;
    const eventMatch = isReason(context.event, ['OOMKilled']);
    const stableAfterOom =
      state?.containerState === 'running' && state.restartDelta === 0;
    const stateMatch =
      state?.scope === 'container' &&
      !stableAfterOom &&
      [state.terminationReason, state.lastTerminationReason].includes(
        'OOMKilled',
      );
    if (!eventMatch && !stateMatch) {
      if (state?.scope === 'container' && state.containerState === 'running')
        return [this.result(resourceFromState(state), null)];
      return [];
    }
    const resource = state
      ? resourceFromState(state)
      : {
          ...resourceFromEvent(context.event),
          scope: context.event.container
            ? ('container' as const)
            : ('pod' as const),
        };
    const evidence = [];
    if (eventMatch)
      evidence.push(
        telemetryEvidence(context.event, 'Kubernetes reported OOMKilled'),
      );
    if (stateMatch)
      evidence.push(
        stateEvidence(state!, 'Container termination reason is OOMKilled'),
      );
    if (state?.memoryUtilizationPercent !== undefined)
      evidence.push(
        calculationEvidence(state, 'Memory utilization before termination', {
          utilizationPercent: state.memoryUtilizationPercent,
        }),
      );
    if (state?.restartDelta && state.restartDelta > 0)
      evidence.push(
        stateEvidence(state, 'Container restart count increased', {
          previous: state.previousRestartCount ?? 0,
          current: state.restartCount!,
          delta: state.restartDelta,
        }),
      );
    return [
      this.result(resource, {
        severity: 'CRITICAL',
        confidence:
          eventMatch || state?.terminationReason === 'OOMKilled' ? 1 : 0.95,
        summary:
          'Container was terminated because it exceeded its memory limit',
        evidence,
      }),
    ];
  }
}

export class CrashLoopRule extends BaseRule {
  readonly ruleId = 'kubernetes.crash-loop.v1';
  readonly classification = 'CRASH_LOOP' as const;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    const state = context.state;
    const backoffEvent = isReason(context.event, [
      'BackOff',
      'CrashLoopBackOff',
    ]);
    if (!state || state.scope !== 'container') return [];
    if (
      context.event.kind !== 'metric' ||
      !['k8s.container.restart_count', 'k8s.container.state'].includes(
        context.event.name,
      )
    )
      return [];
    const resource = resourceFromState(state);
    const backoffs = context.recentEvidence(
      (event) =>
        sameWorkload(resource, event) &&
        isReason(event, ['BackOff', 'CrashLoopBackOff']),
    );
    const increases = context.restartIncreaseCount(resource);
    const waitingReason =
      state.containerState === 'waiting' &&
      state.containerStateReason === 'CrashLoopBackOff';
    if (state.containerState === 'running' && state.restartDelta === 0)
      return [this.result(resource, null)];
    const condition =
      increases >= context.thresholds.restartThreshold &&
      (backoffEvent || backoffs.length > 0 || waitingReason);
    if (!condition) return [];
    const evidence = [
      stateEvidence(state, 'Restart count increased repeatedly', {
        restartIncreases: increases,
        restartCount: state.restartCount ?? 0,
      }),
      ...backoffs
        .slice(-2)
        .map((event) =>
          telemetryEvidence(
            event,
            'Kubernetes reported ' +
              (event.kind === 'kubernetes' ? event.reason : 'backoff'),
          ),
        ),
    ];
    if (waitingReason)
      evidence.push(
        stateEvidence(state, 'Container is waiting with CrashLoopBackOff'),
      );
    return [
      this.result(resource, {
        severity: 'HIGH',
        confidence: backoffs.length || backoffEvent ? 0.95 : 0.85,
        summary:
          'Container is restarting repeatedly with Kubernetes backoff evidence',
        evidence,
      }),
    ];
  }
}

abstract class DurationRule extends BaseRule {
  protected duration(
    context: RuleContext,
    resource: ReturnType<typeof resourceFromState>,
    condition: boolean,
    requiredMs: number,
  ) {
    return (
      context.observe(
        this.ruleId + ':' + anomalyKey(this.classification, resource),
        condition,
      ).durationMs >= requiredMs
    );
  }
}

export class PodNotReadyRule extends DurationRule {
  readonly ruleId = 'kubernetes.pod-not-ready.v1';
  readonly classification = 'POD_NOT_READY' as const;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    const state = context.state;
    if (
      !state ||
      state.scope !== 'pod' ||
      context.event.kind !== 'metric' ||
      context.event.name !== 'k8s.pod.ready' ||
      state.ready === null ||
      state.ready === undefined
    )
      return [];
    const resource = resourceFromState(state);
    const matched = this.duration(
      context,
      resource,
      state.ready === false,
      context.thresholds.notReadyDurationMs,
    );
    if (state.ready || !matched)
      return state.ready ? [this.result(resource, null)] : [];
    return [
      this.result(resource, {
        severity: 'HIGH',
        confidence: 0.95,
        summary: 'Pod has remained not ready',
        evidence: [
          stateEvidence(state, 'Kubernetes pod Ready condition is false'),
        ],
      }),
    ];
  }
}
export class DeploymentDegradedRule extends DurationRule {
  readonly ruleId = 'kubernetes.deployment-degraded.v1';
  readonly classification = 'DEPLOYMENT_DEGRADED' as const;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    const state = context.state;
    if (
      !state ||
      state.scope !== 'deployment' ||
      context.event.kind !== 'metric' ||
      !context.event.name.startsWith('k8s.deployment.replicas.') ||
      state.desiredReplicas === undefined ||
      state.availableReplicas === undefined
    )
      return [];
    const resource = resourceFromState(state);
    const degraded = state.availableReplicas < state.desiredReplicas;
    const matched = this.duration(
      context,
      resource,
      degraded,
      context.thresholds.deploymentDegradationDurationMs,
    );
    if (!degraded || !matched)
      return !degraded ? [this.result(resource, null)] : [];
    return [
      this.result(resource, {
        severity: state.availableReplicas === 0 ? 'CRITICAL' : 'HIGH',
        confidence: 1,
        summary: 'Deployment has fewer available replicas than desired',
        evidence: [
          stateEvidence(state, 'Replica availability is below desired state', {
            desired: state.desiredReplicas,
            available: state.availableReplicas,
            unavailable:
              state.unavailableReplicas ??
              state.desiredReplicas - state.availableReplicas,
          }),
        ],
      }),
    ];
  }
}
export class NodeNotReadyRule extends DurationRule {
  readonly ruleId = 'kubernetes.node-not-ready.v1';
  readonly classification = 'NODE_NOT_READY' as const;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    const state = context.state;
    const ready =
      state?.scope === 'node' ? state.nodeConditions?.ready : undefined;
    if (
      !state ||
      context.event.kind !== 'metric' ||
      context.event.name !== 'k8s.node.condition_ready' ||
      ready === undefined ||
      ready === null
    )
      return [];
    const resource = resourceFromState(state);
    const matched = this.duration(
      context,
      resource,
      ready === false,
      context.thresholds.notReadyDurationMs,
    );
    if (ready || !matched) return ready ? [this.result(resource, null)] : [];
    return [
      this.result(resource, {
        severity: 'CRITICAL',
        confidence: 1,
        summary: 'Kubernetes node Ready condition is false',
        evidence: [stateEvidence(state, 'Node Ready condition is false')],
      }),
    ];
  }
}

abstract class KubernetesReasonRule extends BaseRule {
  abstract readonly reasons: readonly string[];
  abstract readonly severity: 'WARNING' | 'HIGH' | 'CRITICAL';
  abstract readonly summary: string;
  evaluate(context: RuleContext): readonly RuleEvaluation[] {
    if (isReason(context.event, this.reasons)) {
      const resource = resourceFromEvent(context.event);
      return [
        this.result(resource, {
          severity: this.severity,
          confidence: 1,
          summary: this.summary,
          evidence: [
            telemetryEvidence(
              context.event,
              'Kubernetes reported ' + context.event.reason,
            ),
          ],
        }),
      ];
    }
    const state = context.state;
    if (state?.scope === 'pod' && state.ready === true)
      return [this.result(resourceFromState(state), null)];
    if (
      state?.scope === 'container' &&
      state.ready === true &&
      state.containerState === 'running'
    )
      return [
        this.result(
          { ...resourceFromState(state), scope: 'pod', container: undefined },
          null,
        ),
      ];
    return [];
  }
}

export class FailedSchedulingRule extends KubernetesReasonRule {
  readonly ruleId = 'kubernetes.failed-scheduling.v1';
  readonly classification = 'FAILED_SCHEDULING' as const;
  readonly reasons = ['FailedScheduling'];
  readonly severity = 'HIGH' as const;
  readonly summary = 'Kubernetes could not schedule the pod';
}
export class ImagePullFailureRule extends KubernetesReasonRule {
  readonly ruleId = 'kubernetes.image-pull-failure.v1';
  readonly classification = 'IMAGE_PULL_FAILURE' as const;
  readonly reasons = [
    'ErrImagePull',
    'ImagePullBackOff',
    'FailedPullImage',
    'InvalidImageName',
  ];
  readonly severity = 'HIGH' as const;
  readonly summary = 'Kubernetes could not pull a container image';
}
export class FailedMountRule extends KubernetesReasonRule {
  readonly ruleId = 'kubernetes.failed-mount.v1';
  readonly classification = 'FAILED_MOUNT' as const;
  readonly reasons = ['FailedMount', 'FailedAttachVolume'];
  readonly severity = 'HIGH' as const;
  readonly summary = 'Kubernetes could not mount a required volume';
}

export function createDefaultRules(): readonly AnomalyRule[] {
  return [
    new OomKilledRule(),
    new CrashLoopRule(),
    new HighMemoryUtilizationRule(),
    new HighCpuUtilizationRule(),
    new PodNotReadyRule(),
    new DeploymentDegradedRule(),
    new FailedSchedulingRule(),
    new ImagePullFailureRule(),
    new FailedMountRule(),
    new NodeNotReadyRule(),
  ];
}
