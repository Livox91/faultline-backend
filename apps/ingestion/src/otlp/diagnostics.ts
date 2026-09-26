import { Controller, Get, Header, Injectable } from '@nestjs/common';

export type OtlpSignal = 'logs' | 'metrics';

interface SignalCounters {
  batches: number;
  received: number;
  normalized: number;
  rejected: number;
  queued: number;
  publishFailures: number;
  rejectionReasons: Record<string, number>;
  lastSuccessfulIngestion?: string;
}

function counters(): SignalCounters {
  return {
    batches: 0,
    received: 0,
    normalized: 0,
    rejected: 0,
    queued: 0,
    publishFailures: 0,
    rejectionReasons: {},
  };
}

/** Process-local, payload-free counters for tracing the collector/ingestion boundary. */
@Injectable()
export class OtlpDiagnostics {
  private readonly signals: Record<OtlpSignal, SignalCounters> = {
    logs: counters(),
    metrics: counters(),
  };

  translated(
    signal: OtlpSignal,
    received: number,
    normalized: number,
    rejected: number,
    reasons: Readonly<Record<string, number>>,
  ): void {
    const current = this.signals[signal];
    current.batches++;
    current.received += received;
    current.normalized += normalized;
    current.rejected += rejected;
    for (const [reason, count] of Object.entries(reasons))
      current.rejectionReasons[reason] =
        (current.rejectionReasons[reason] ?? 0) + count;
  }

  published(signal: OtlpSignal, count: number): void {
    const current = this.signals[signal];
    current.queued += count;
    current.lastSuccessfulIngestion = new Date().toISOString();
  }

  publishFailed(signal: OtlpSignal): void {
    this.signals[signal].publishFailures++;
  }

  snapshot() {
    return {
      status: 'healthy',
      scope: 'process_lifetime',
      pipeline: structuredClone(this.signals),
    };
  }
}

@Controller('v1/otlp/diagnostics')
export class OtlpDiagnosticsController {
  constructor(private readonly diagnostics: OtlpDiagnostics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get() {
    return this.diagnostics.snapshot();
  }
}
