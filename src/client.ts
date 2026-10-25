/**
 * The World's side of the wire: one WebSocket to the DSH Host plugin, with the reconnect policy a
 * second process on the same machine needs.
 *
 * Two rules shape it. A DSH notice is only worth showing while it is fresh, so a frame that arrives
 * while the pet was disconnected is lost rather than replayed. The person's own words are not
 * notices: `say` is acknowledged, so a line that DSH never accepted is reported instead of
 * vanishing.
 */
import { WebSocket } from 'ws';
import { SEND_MAX } from './config.ts';

/** The revision this package speaks; the Host refuses another one. */
export const PROTOCOL_VERSION = 1;

/** Host→pet frames, as `coopanion-connector-dsh/src/protocol.ts` declares them. */
export type HostFrame =
  | { t: 'ready'; v: number; session: string; cwd: string; model: string }
  | { t: 'turn-start'; turn: number }
  | { t: 'turn-end'; turn: number; reason: string }
  | { t: 'reply'; turn: number; text: string }
  | { t: 'tool'; name: string; detail: string }
  | { t: 'approval'; name: string; reason: string }
  | { t: 'question'; text: string }
  | { t: 'error'; text: string }
  | { t: 'accepted'; id: string }
  | { t: 'refused'; id: string; reason: string }
  /** Answer to a `pick` request: the pet now speaks into this session. */
  | { t: 'picked'; session: string }
  /** Answer to a `pick` request: the Host refused the switch (session not live). */
  | { t: 'refused'; reason: string };

export interface DshClientOptions {
  /** Read at each attempt, so a corrected address is used by the next reconnect. */
  url(): string;
  /** What the Host is told about this pet on connect. */
  name(): string;
  /** A frame from the Host; `ready` means the connection is usable. */
  onFrame(frame: HostFrame): void;
  /** Connection state changed; false covers both a failed attempt and a dropped socket. */
  onState(connected: boolean, detail: DshSession | null): void;
  log(level: 'info' | 'warn', text: string): void;
}

/** What the Host said about itself in `ready`. */
export interface DshSession {
  session: string;
  cwd: string;
  model: string;
}

/** Backoff for the first attempts; the last value repeats. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

export class DshClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** `say` frames waiting for the Host's answer, by id. */
  private readonly waiting = new Map<string, { resolve: (refusal: string | null) => void; timer: NodeJS.Timeout }>();
  /** `pick` frames waiting for the Host's answer, by session id. */
  private readonly waitingPick = new Map<string, { resolve: (refusal: string | null) => void; timer: NodeJS.Timeout }>();
  private seq = 0;

  constructor(private readonly opts: DshClientOptions) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [, entry] of this.waiting) {
      clearTimeout(entry.timer);
      entry.resolve('the bridge stopped before DSH answered');
    }
    this.waiting.clear();
    for (const [, entry] of this.waitingPick) {
      clearTimeout(entry.timer);
      entry.resolve('the bridge stopped before DSH answered');
    }
    this.waitingPick.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      // A socket still shaking hands aborts with an error instead of a close frame; nobody is
      // listening for it, so it is swallowed rather than left to crash the process.
      if (socket.readyState === socket.CONNECTING) {
        socket.on('error', () => {});
        socket.terminate();
      } else {
        socket.close(1000, 'pet closing');
      }
    }
    this.opts.onState(false, null);
  }

  /**
   * Reconnect at once instead of waiting out the backoff. Called when the address itself moved: the
   * timer only exists to space out attempts against an address we still believe in.
   */
  retryNow(): void {
    if (this.stopped || this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  }

  /**
   * One line into DSH; resolves `null` when DSH accepted it, `'unsent'` when the line provably
   * never left (the bridge was down or the socket refused the write), or a reason otherwise.
   *
   * The split matters to the caller: an `'unsent'` line can be queued and handed over once the
   * bridge is back, while a timeout means the line may have reached DSH anyway — re-sending that
   * would put the person's words into the conversation twice, so the caller reports it instead.
   *
   * A `say` that never gets an answer resolves rather than hanging: the caller shows a bubble, and
   * a bubble that waits forever is worse than one that says the message did not arrive.
   */
  say(text: string): Promise<string | null> {
    const body = text.trim().slice(0, SEND_MAX);
    if (!body) return Promise.resolve('empty message');
    if (!this.connected) return Promise.resolve('unsent');
    const id = `p${++this.seq}`;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve('DSH did not answer in time');
      }, 15_000);
      timer.unref?.();
      this.waiting.set(id, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify({ t: 'say', id, text: body, from: this.opts.name() }));
      } catch (err) {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve('unsent');
      }
    });
  }

  /**
   * Point the pet at a specific DSH session. Resolves `null` when the Host switched, or the refusal
   * reason (typically the session is not open). Resolves `'unsent'` when the bridge is down.
   *
   * The Host's default owner is the newest live session; this lets a person keep using an older one
   * after archiving the current conversation.
   */
  pick(session: string): Promise<string | null> {
    const id = session.trim().slice(0, 128);
    if (!id) return Promise.resolve('empty session id');
    if (!this.connected) return Promise.resolve('unsent');
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waitingPick.delete(id);
        resolve('DSH did not answer in time');
      }, 15_000);
      timer.unref?.();
      this.waitingPick.set(id, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify({ t: 'pick', session: id }));
      } catch {
        clearTimeout(timer);
        this.waitingPick.delete(id);
        resolve('unsent');
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.url());
    } catch (err) {
      this.failed(`bad address: ${(err as Error).message}`);
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      this.attempt = 0;
      socket.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: this.opts.name() }));
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parseHostFrame(data.toString());
      if (!frame) return;
      if (frame.t === 'ready') {
        if (frame.v !== PROTOCOL_VERSION) {
          this.opts.log('warn', `DSH Host speaks protocol ${frame.v}, this pet speaks ${PROTOCOL_VERSION}`);
          socket.close(1002, 'protocol mismatch');
          return;
        }
        this.opts.onState(true, { session: frame.session, cwd: frame.cwd, model: frame.model });
        return;
      }
      if (frame.t === 'accepted' || frame.t === 'refused') {
        // A `refused` frame without an id answers a `pick`, not a `say`.
        if (frame.t === 'refused' && !('id' in frame)) {
          const entry = [...this.waitingPick.values()][0];
          if (!entry) return;
          clearTimeout(entry.timer);
          this.waitingPick.clear();
          entry.resolve(frame.reason);
          return;
        }
        const entry = this.waiting.get((frame as { id: string }).id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waiting.delete((frame as { id: string }).id);
        entry.resolve(frame.t === 'accepted' ? null : (frame as { reason: string }).reason);
        return;
      }
      if (frame.t === 'picked') {
        const entry = this.waitingPick.get(frame.session);
        if (entry) {
          clearTimeout(entry.timer);
          this.waitingPick.delete(frame.session);
          entry.resolve(null);
        }
        return;
      }
      this.opts.onFrame(frame);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.failed('closed');
    });
    socket.on('error', (err: Error) => {
      if (this.socket !== socket) return;
      this.opts.log('info', `DSH bridge: ${err.message}`);
    });
    socket.on('unexpected-response', (_req, res) => {
      if (this.socket !== socket) return;
      // The server answered the handshake and said no. A 503 means DSH's web server is up but the
      // Host plugin did not take the upgrade; a 404 means nothing listens on this path. Either way
      // this is not a dropped socket, and without the status the log reads as if it were.
      this.opts.log('warn', `DSH bridge upgrade rejected: HTTP ${res.statusCode ?? 0}`);
      res.resume();
      socket.terminate();
    });
  }

  private failed(detail: string): void {
    this.opts.onState(false, null);
    if (this.stopped || this.timer) return;
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]!;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
    this.timer.unref?.();
  }
}

/** One frame the Host sent, or null when it is not one this pet understands. */
export function parseHostFrame(raw: string): HostFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const str = (key: string): string | null => (typeof frame[key] === 'string' ? (frame[key] as string) : null);
  const num = (key: string): number | null => (typeof frame[key] === 'number' && Number.isFinite(frame[key]) ? (frame[key] as number) : null);
  switch (frame.t) {
    case 'ready': {
      const v = num('v');
      const session = str('session');
      if (v === null || session === null) return null;
      return { t: 'ready', v, session, cwd: str('cwd') ?? '', model: str('model') ?? '' };
    }
    case 'turn-start': {
      const turn = num('turn');
      return turn === null ? null : { t: 'turn-start', turn };
    }
    case 'turn-end': {
      const turn = num('turn');
      return turn === null ? null : { t: 'turn-end', turn, reason: str('reason') ?? 'completed' };
    }
    case 'reply': {
      const text = str('text');
      return text === null ? null : { t: 'reply', turn: num('turn') ?? 0, text };
    }
    case 'tool': {
      const name = str('name');
      return name === null ? null : { t: 'tool', name, detail: str('detail') ?? '' };
    }
    case 'approval': {
      const name = str('name');
      return name === null ? null : { t: 'approval', name, reason: str('reason') ?? '' };
    }
    case 'question': {
      const text = str('text');
      return text === null ? null : { t: 'question', text };
    }
    case 'error': {
      const text = str('text');
      return text === null ? null : { t: 'error', text };
    }
    case 'accepted':
    case 'refused': {
      const id = str('id');
      // A `refused` with no id answers a `pick` request; one with an id answers a `say`.
      if (frame.t === 'refused' && id === null) return { t: 'refused', reason: str('reason') ?? '' };
      if (id === null) return null;
      return frame.t === 'accepted' ? { t: 'accepted', id } : { t: 'refused', id, reason: str('reason') ?? '' };
    }
    case 'picked': {
      const session = str('session');
      return session === null ? null : { t: 'picked', session };
    }
    default:
      return null;
  }
}
