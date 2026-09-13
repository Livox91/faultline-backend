import type {
  LogClassificationRepository,
  LogClassificationResult,
  LogPatternAggregate,
} from '@faultline/log-classification';
import type { RedisConnection } from '../infrastructure/redis';

const prefix = 'faultline:log-classification:v1';

/** Short-lived, atomic pattern aggregation; raw logs remain durable in ClickHouse. */
export class RedisLogClassificationRepository implements LogClassificationRepository {
  constructor(private readonly redis: RedisConnection) {}

  async save(
    result: LogClassificationResult,
    context: {
      clusterId: string;
      namespace?: string;
      workload?: string;
      pod?: string;
      aggregationWindowMs: number;
    },
  ): Promise<LogPatternAggregate> {
    const ttl = Math.max(
      60,
      Math.ceil((context.aggregationWindowMs * 2) / 1000),
    );
    const initial: LogPatternAggregate & { firstMs: number; lastMs: number } = {
      patternId: result.patternId,
      classification: result.classification,
      clusterId: context.clusterId,
      ...(context.namespace ? { namespace: context.namespace } : {}),
      ...(context.workload ? { workload: context.workload } : {}),
      count: 0,
      firstSeen: result.timestamp,
      lastSeen: result.timestamp,
      affectedPods: [],
      firstMs: Date.parse(result.timestamp),
      lastMs: Date.parse(result.timestamp),
    };
    const serialized = (await this.redis.client.eval(
      `
        local duplicate = redis.call('EXISTS', KEYS[1])
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[7])
        local aggregate = cjson.decode(ARGV[2])
        local raw = redis.call('GET', KEYS[2])
        if raw then
          local prior = cjson.decode(raw)
          if tonumber(ARGV[3]) >= prior.lastMs - tonumber(ARGV[5]) and tonumber(ARGV[3]) - prior.lastMs <= tonumber(ARGV[5]) then aggregate = prior end
        end
        if duplicate == 0 then aggregate.count = aggregate.count + 1 end
        local event_ms = tonumber(ARGV[3])
        if event_ms < aggregate.firstMs then
          aggregate.firstMs = event_ms
          aggregate.firstSeen = ARGV[4]
        end
        if event_ms > aggregate.lastMs then
          aggregate.lastMs = event_ms
          aggregate.lastSeen = ARGV[4]
        end
        if ARGV[6] ~= '' then
          local present = false
          for _, pod in ipairs(aggregate.affectedPods) do if pod == ARGV[6] then present = true end end
          if not present then table.insert(aggregate.affectedPods, ARGV[6]) end
          table.sort(aggregate.affectedPods)
        end
        redis.call('SET', KEYS[2], cjson.encode(aggregate), 'EX', ARGV[7])
        return cjson.encode(aggregate)
      `,
      {
        keys: [
          this.resultKey(result.eventId),
          this.patternKey(result.patternId),
        ],
        arguments: [
          JSON.stringify(result),
          JSON.stringify(initial),
          String(Date.parse(result.timestamp)),
          result.timestamp,
          String(context.aggregationWindowMs),
          context.pod ?? '',
          String(ttl),
        ],
      },
    )) as string;
    return publicAggregate(JSON.parse(serialized));
  }

  async get(eventId: string): Promise<LogClassificationResult | undefined> {
    const value = await this.redis.client.get(this.resultKey(eventId));
    return value ? JSON.parse(value) : undefined;
  }

  async getPattern(
    patternId: string,
  ): Promise<LogPatternAggregate | undefined> {
    const value = await this.redis.client.get(this.patternKey(patternId));
    return value ? publicAggregate(JSON.parse(value)) : undefined;
  }

  private resultKey(eventId: string): string {
    return `${prefix}:result:${eventId}`;
  }
  private patternKey(patternId: string): string {
    return `${prefix}:pattern:${patternId}`;
  }
}

function publicAggregate(
  value: LogPatternAggregate & { firstMs?: number; lastMs?: number },
): LogPatternAggregate {
  const { firstMs: _firstMs, lastMs: _lastMs, ...aggregate } = value;
  return aggregate;
}
