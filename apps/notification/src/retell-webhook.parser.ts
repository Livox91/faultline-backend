import type { VoiceAction } from '@faultline/notifications';

type JsonObject = Record<string, unknown>;

const decisions = new Set<VoiceAction>([
  'ACKNOWLEDGE_INCIDENT',
  'DECLINE_INCIDENT',
]);

export function extractRetellVoiceAction(payload: unknown): VoiceAction | undefined {
  const explicit = findExplicitDecision(payload, 0, new Set());
  if (explicit) return explicit;
  if (!isEndOfCall(payload)) return undefined;
  const utterance = lastUserUtterance(payload);
  return utterance ? classifyUtterance(utterance) : undefined;
}

function findExplicitDecision(
  value: unknown,
  depth: number,
  seen: Set<object>,
): VoiceAction | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (decisions.has(normalized as VoiceAction)) return normalized as VoiceAction;
    if ((value.startsWith('{') || value.startsWith('[')) && value.length < 20_000) {
      try {
        return findExplicitDecision(JSON.parse(value), depth + 1, seen);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value as JsonObject);
  for (const child of children) {
    const decision = findExplicitDecision(child, depth + 1, seen);
    if (decision) return decision;
  }
  return undefined;
}

function isEndOfCall(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const body = payload as JsonObject;
  const call = body.call && typeof body.call === 'object' ? body.call as JsonObject : body;
  const event = String(body.event ?? '').toLowerCase();
  const status = String(call.call_status ?? '').toLowerCase();
  return ['call_ended', 'call_analyzed'].includes(event) || ['ended', 'completed'].includes(status);
}

function lastUserUtterance(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as JsonObject;
  const call = body.call && typeof body.call === 'object' ? body.call as JsonObject : body;
  for (const field of ['transcript_object', 'transcript_with_tool_calls']) {
    const entries = call[field];
    if (!Array.isArray(entries)) continue;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as JsonObject;
      const role = String(item.role ?? item.speaker ?? '').toLowerCase();
      if (!['user', 'caller', 'human'].includes(role)) continue;
      const content = item.content ?? item.text ?? item.words;
      if (typeof content === 'string' && content.trim()) return content.trim();
    }
  }
  const transcript = call.transcript;
  if (typeof transcript !== 'string') return undefined;
  const userLines = transcript.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:user|caller|human)\s*:\s*(.+)$/i);
    return match?.[1] ? [match[1].trim()] : [];
  });
  if (userLines.length) return userLines[userLines.length - 1];
  const plain = transcript.trim();
  return plain.length <= 120 && !plain.includes('\n') ? plain : undefined;
}

function classifyUtterance(value: string): VoiceAction | undefined {
  const text = value.toLowerCase().replace(/[’]/g, "'").trim();
  if (
    /\b(decline|declined|reject|refuse)\b/.test(text) ||
    /\b(can't|cannot|won't|will not|do not|don't)\s+(acknowledge|accept|take|handle)\b/.test(text) ||
    /^(no|nope|negative)\b/.test(text)
  ) return 'DECLINE_INCIDENT';
  if (
    /\b(acknowledge|acknowledged|accept|accepted)\b/.test(text) ||
    /\b(i am|i'm|we are|we're)\s+on\s+it\b/.test(text) ||
    /\b(i|we)\s+(will|'ll|can)\s+(take|handle)\b/.test(text) ||
    /^(yes|yeah|yep|affirmative|okay|ok)\b/.test(text)
  ) return 'ACKNOWLEDGE_INCIDENT';
  return undefined;
}
