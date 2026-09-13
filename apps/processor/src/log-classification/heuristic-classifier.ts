import type { LogClassification } from '@faultline/log-classification';
import type { LogEvent } from '@faultline/telemetry';
import { defaultLogPatternRules, type LogPatternRule } from './patterns';

export interface HeuristicClassification {
  classification: LogClassification;
  confidence: number;
  ruleId: string;
  matchedSignals: readonly string[];
  excerpt?: string;
}

export class HeuristicLogClassifier {
  constructor(
    private readonly rules: readonly LogPatternRule[] = defaultLogPatternRules,
  ) {}

  classify(event: LogEvent): HeuristicClassification | undefined {
    const candidates = this.rules
      .map((rule, priority) => {
        const matched = rule.signals.filter((item) => {
          const found = item.pattern.test(event.message);
          item.pattern.lastIndex = 0;
          return found;
        });
        return {
          rule,
          priority,
          matched,
          weight: matched.reduce((total, item) => total + item.weight, 0),
        };
      })
      .filter((item) => item.weight >= item.rule.minimumWeight)
      .sort(
        (left, right) =>
          right.weight - left.weight || left.priority - right.priority,
      );
    const winner = candidates[0];
    if (!winner) return undefined;
    return {
      classification: winner.rule.classification,
      confidence: round(Math.min(0.99, 0.55 + winner.weight * 0.35)),
      ruleId: winner.rule.id,
      matchedSignals: winner.matched.map((item) => item.label),
      excerpt: winner.matched.map((item) => item.label).join(', '),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
