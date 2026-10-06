import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ApplicationLogger } from '@faultline/platform';
import { NOTIFICATION_CONFIG, type NotificationWorkerConfig } from './config';
import { SlackEventProcessor, type SlackEventBody } from './slack-event.processor';

export const SLACK_SOCKET_FETCH = Symbol('faultline.slack-socket-fetch');
export const SLACK_SOCKET_FACTORY = Symbol('faultline.slack-socket-factory');

interface SocketMessageEvent { data: unknown; }
interface SlackSocket {
  readonly readyState: number;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: SocketMessageEvent) => void): void;
  send(data: string): void;
  close(): void;
}
type SocketFactory = (url: string) => SlackSocket;
type Fetcher = typeof fetch;

type SocketEnvelope = {
  type?: unknown;
  envelope_id?: unknown;
  payload?: SlackEventBody;
  reason?: unknown;
};

@Injectable()
export class SlackSocketModeService implements OnModuleInit, OnModuleDestroy {
  private readonly fetcher: Fetcher;
  private readonly socketFactory: SocketFactory;
  private socket?: SlackSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 1_000;
  private connecting = false;
  private stopped = false;

  constructor(
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationWorkerConfig,
    private readonly events: SlackEventProcessor,
    private readonly logger: ApplicationLogger,
    @Optional() @Inject(SLACK_SOCKET_FETCH) fetcher?: Fetcher,
    @Optional() @Inject(SLACK_SOCKET_FACTORY) socketFactory?: SocketFactory,
  ) {
    this.fetcher = fetcher ?? fetch;
    this.socketFactory = socketFactory ?? ((url) => new WebSocket(url) as unknown as SlackSocket);
  }

  onModuleInit(): void {
    if (this.config.slack.socketModeEnabled) void this.connect();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const token = this.config.slack.appToken;
      if (!token) throw new Error('Slack Socket Mode app token is missing');
      const response = await this.fetcher('https://slack.com/api/apps.connections.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { ok?: boolean; url?: string; error?: string };
      if (!response.ok || !result.ok || !result.url?.startsWith('wss://'))
        throw new Error(`Slack Socket Mode connection failed (${safeCode(result.error)})`);
      const socket = this.socketFactory(result.url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.reconnectDelayMs = 1_000;
        this.logger.log({ event: 'slack.socket.connected' });
      });
      socket.addEventListener('message', (event) => void this.receive(socket, event.data));
      socket.addEventListener('error', () => {
        this.logger.warn({ event: 'slack.socket.error' });
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = undefined;
        this.logger.warn({ event: 'slack.socket.disconnected' });
        this.scheduleReconnect();
      });
    } catch (error) {
      this.logger.warn({
        event: 'slack.socket.connection_failed',
        errorCode: error instanceof Error ? safeCode(error.message) : 'unexpected_error',
      });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async receive(socket: SlackSocket, data: unknown): Promise<void> {
    try {
      const envelope = JSON.parse(await socketText(data)) as SocketEnvelope;
      if (envelope.type === 'disconnect') {
        socket.close();
        return;
      }
      if (
        envelope.type !== 'events_api' ||
        typeof envelope.envelope_id !== 'string' ||
        !envelope.payload
      ) return;
      await this.events.process(envelope.payload);
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    } catch (error) {
      this.logger.warn({
        event: 'slack.socket.event_failed',
        errorCode: error instanceof Error ? safeCode(error.message) : 'unexpected_error',
      });
      // Do not acknowledge failed processing; Slack may redeliver the envelope.
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}

async function socketText(value: unknown): Promise<string> {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  if (value instanceof Blob) return value.text();
  throw new Error('Unsupported Slack Socket Mode payload');
}

function safeCode(value: string | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 80) || 'slack_socket_error';
}
