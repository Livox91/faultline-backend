/** Pure arithmetic only; these values carry no severity or classification. */
export function utilizationPercent(
  usage: number | undefined,
  limit: number | undefined,
): number | undefined {
  if (
    usage === undefined ||
    limit === undefined ||
    !Number.isFinite(usage) ||
    !Number.isFinite(limit) ||
    usage < 0 ||
    limit <= 0
  )
    return undefined;
  const result = (usage / limit) * 100;
  return Number.isFinite(result) ? Math.round(result * 100) / 100 : undefined;
}

export function memoryBytes(value: number, unit?: string): number | undefined {
  const factors: Record<string, number> = {
    By: 1,
    bytes: 1,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    kB: 1000,
    MB: 1e6,
    GB: 1e9,
  };
  const factor = factors[unit ?? ''];
  const result = factor === undefined ? NaN : value * factor;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

export function cpuCores(value: number, unit?: string): number | undefined {
  const factors: Record<string, number> = {
    cores: 1,
    core: 1,
    '{cpu}': 1,
    m: 0.001,
    millicores: 0.001,
  };
  const factor = factors[unit ?? ''];
  const result = factor === undefined ? NaN : value * factor;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

export function restartChange(previous: number | undefined, current: number) {
  return {
    previousRestartCount: previous,
    restartCount: current,
    restartDelta:
      previous === undefined || current < previous
        ? undefined
        : current - previous,
    restartCounterReset: previous !== undefined && current < previous,
  };
}
