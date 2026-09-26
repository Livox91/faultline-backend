const { spawnSync } = require('node:child_process');

function parseExcludedPortRanges(output) {
  const ranges = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$/.exec(line);
    if (!match) continue;
    ranges.push({ start: Number(match[1]), end: Number(match[2]) });
  }
  return ranges;
}

function windowsExcludedTcpRanges() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync(
    'netsh',
    ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error || result.status !== 0) return [];
  return parseExcludedPortRanges(result.stdout);
}

function isPortExcluded(port, ranges) {
  return ranges.some(({ start, end }) => port >= start && port <= end);
}

function chooseUnexcludedPort(preferred, ranges) {
  const candidates = [preferred, 5432, 15432, 25432, 35432, 45432, 6543];
  return candidates.find(
    (port, index) =>
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      candidates.indexOf(port) === index &&
      !isPortExcluded(port, ranges),
  );
}

module.exports = {
  parseExcludedPortRanges,
  windowsExcludedTcpRanges,
  isPortExcluded,
  chooseUnexcludedPort,
};
