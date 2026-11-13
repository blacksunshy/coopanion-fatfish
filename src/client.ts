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

/** One live DSH conversation, as both `session-list` and the acks describe it. */
export interface SessionRow {
  id: string;
  cwd: string;
  model: string;
  /**
   * The conversation's title, as DSH shows it in its own sidebar — the thing the person uses to
   * tell one conversation from another. Absent from a Host older than 0.2.22, and empty for a
   * conversation nobody has named yet, so a reader must treat both as "no title to show".
   */
  title?: string;
  /**
   * Whether the conversation is working right now — a turn is open and the model is still going.
   *
   * The difference between "it is busy" and "it ignored me" matters to a bot: without this it
   * either repeats itself into a conversation that is still answering, or treats silence as a
   * refusal. Absent from a Host older than 0.2.23, so a reader must not read absent as idle.
   */
  running?: boolean;
  owner: boolean;
  pinned: boolean;
  subagent: boolean;
}

/** Host→pet frames, as `coopanion-connector-dsh/src/protocol.ts` declares them. */
export type HostFrame =
  /**
   * The connection is usable and names the conversation a targetless line lands in. From connector
   * 0.2.20 it also carries every open conversation, so the pet knows the menu without asking.
   */
  | { t: 'ready'; v: number; session: string; cwd: string; model: string; sessions?: SessionRow[]; pinned?: boolean }
  | { t: 'turn-start'; turn: number }
  | { t: 'turn-end'; turn: number; reason: string; used?: number; size?: number }
  | { t: 'reply'; turn: number; text: string }
  | { t: 'tool'; name: string; detail: string }
  | { t: 'approval'; name: string; reason: string }
  | { t: 'question'; text: string; callId?: string }
  /** The question above was answered, skipped or timed out; stop any reminder. */
  | { t: 'question-end'; callId: string }
  | { t: 'error'; text: string }
  /** The words were delivered: `session` names the conversation that took them. */
  | { t: 'accepted'; id: string; session?: string; sessions?: SessionRow[]; pinned?: boolean }
  | {
      t: 'refused';
      id: string;
      reason: string;
      /** Why, in a form code can branch on: `stale-session`, `no-session`, `forwarding-off`, … */
      code?: string;
      sessions?: SessionRow[];
      pinned?: boolean;
    }
  /** Answer to a `pick` request: the pet now speaks into this session. */
  | { t: 'picked'; session: string }
  /** Answer to a `pick` request: the Host refused the switch (session not live). */
  | { t: 'refused'; reason: string }
  /**
   * The open conversations and who owns them: the answer to `list-sessions`, and from connector
   * 0.2.20 also a push the Host sends whenever a conversation opens or is disposed.
   */
  | { t: 'session-list'; sessions: SessionRow[]; pinned: boolean; owner?: string | null }
  /** Answer to `unpin`: the Host dropped the pin, auto-follow takes over again. */
  | { t: 'unpinned' }
  /**
   * Answer to a `new` request: the Host created this conversation and owns it now.
   *
   * `workspace` is the path the conversation actually landed in. A Host from before this field
   * never knew about the request, so a pet that asked for a workspace must not read the missing
   * field as success.
   */
  | { t: 'created'; id: string; session: string; workspace?: string }
  /** Answer to `list-workspaces`: the projects a `new` may target. */
  | { t: 'workspace-list'; workspaces: Array<{ id: string; path: string; sessions: number; owner: boolean }> };

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
  /** Every open conversation, on a Host from connector 0.2.20 on. */
  sessions?: SessionRow[];
  pinned?: boolean;
}

/** Answer to `list-sessions`: the picker's raw material, plus the owner a targetless say lands in. */
export interface SessionList {
  sessions: SessionRow[];
  pinned: boolean;
  /** The conversation the Host would deliver to right now; absent on a Host before 0.2.20. */
  owner?: string | null;
}

/**
 * What one `say` settled to.
 *
 * `refusal` alone is not enough to decide what to do next: the person can only act on a delivery
 * failure if the pet knows whether the conversation went away (`stale-session`), never existed
 * (`no-session`), or the Host is simply not forwarding. `code` is that distinction, and `sessions`
 * is the list as it stood at the moment of the answer, so the retry does not need a second round
 * trip — or worse, a guess.
 */
export type SayOutcome =
  /** Delivered; `session` is the conversation that took the words. */
  | { ok: true; session?: string; sessions?: SessionRow[]; pinned?: boolean }
  | { ok: false; reason: string; code?: string; sessions?: SessionRow[]; pinned?: boolean };

/** Answer to `list-workspaces`: where a `new` may put a conversation. */
export interface WorkspaceList {
  workspaces: Array<{ id: string; path: string; sessions: number; owner: boolean }>;
}

/** What a `new` request settled to: the conversation the Host made, or why it made none. */
export type NewSessionOutcome = { ok: true; session: string; workspace?: string } | { ok: false; reason: string };

/** Backoff for the first attempts; the last value repeats. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

export class DshClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** `say` frames waiting for the Host's answer, by id. */
  private readonly waiting = new Map<string, { resolve: (outcome: SayOutcome) => void; timer: NodeJS.Timeout }>();
  /** `pick` frames waiting for the Host's answer, by session id. */
  private readonly waitingPick = new Map<string, { resolve: (refusal: string | null) => void; timer: NodeJS.Timeout }>();
  /** The one `list-sessions` frame waiting for the Host's answer, if any. */
  private waitingList:
    | { resolve: (result: SessionList | null) => void; timer: NodeJS.Timeout; promise: Promise<SessionList | null> }
    | null = null;
  /** The one `list-workspaces` frame waiting for the Host's answer, if any. */
  private waitingWorkspaces:
    | { resolve: (result: WorkspaceList | null) => void; timer: NodeJS.Timeout; promise: Promise<WorkspaceList | null> }
    | null = null;
  /** The one `unpin` frame waiting for the Host's answer, if any. */
  private waitingUnpin: { resolve: (refusal: string | null) => void; timer: NodeJS.Timeout } | null = null;
  /** `new` frames waiting for the Host's answer, by request id. */
  private readonly waitingNew = new Map<string, { resolve: (outcome: NewSessionOutcome) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  /**
   * The open conversations as last described by the Host — by `ready`, a pushed `session-list`, or
   * an ack. This is the list in hand, so naming a target on the next line costs no round trip.
   */
  private known: SessionRow[] | null = null;

  constructor(private readonly opts: DshClientOptions) {}

  /**
   * Every conversation the Host last said was open, or `null` when it has not said yet (an older
   * Host never does). A caller that wants a fresh answer asks `listSessions()`.
   */
  knownSessions(): SessionRow[] | null {
    return this.known ? [...this.known] : null;
  }

  /** Replace the list in hand. Called for `ready`, pushed lists and every ack that carries one. */
  private remember(sessions: SessionRow[] | undefined): void {
    if (Array.isArray(sessions)) this.known = sessions;
  }

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
      entry.resolve({ ok: false, reason: 'the bridge stopped before DSH answered', code: 'unsent' });
    }
    this.waiting.clear();
    for (const [, entry] of this.waitingPick) {
      clearTimeout(entry.timer);
      entry.resolve('the bridge stopped before DSH answered');
    }
    this.waitingPick.clear();
    if (this.waitingList) {
      clearTimeout(this.waitingList.timer);
      this.waitingList.resolve(null);
      this.waitingList = null;
    }
    if (this.waitingWorkspaces) {
      clearTimeout(this.waitingWorkspaces.timer);
      this.waitingWorkspaces.resolve(null);
      this.waitingWorkspaces = null;
    }
    if (this.waitingUnpin) {
      clearTimeout(this.waitingUnpin.timer);
      this.waitingUnpin.resolve('the bridge stopped before DSH answered');
      this.waitingUnpin = null;
    }
    for (const [, entry] of this.waitingNew) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, reason: 'the bridge stopped before DSH answered' });
    }
    this.waitingNew.clear();
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
   * One line into DSH, optionally naming the conversation that should take it.
   *
   * The name is the whole point. DSH has no "currently focused conversation" signal — a person who
   * merely switches tabs emits nothing — so the Host's own owner is a guess that can be hours stale.
   * Naming the target makes the Host check it against the live list at the moment of delivery and
   * refuse rather than quietly re-route; see `SayOutcome` for what the answer says about it.
   *
   * Resolves `{ ok: false, reason: 'unsent' }` when the line provably never left (the bridge was down
   * or the socket refused the write). That is the one refusal worth queueing: any other answer means
   * the line may have arrived, and re-sending it would put the person's words in twice.
   *
   * A `say` that never gets an answer resolves rather than hanging: the caller shows a bubble, and a
   * bubble that waits forever is worse than one that says the message did not arrive.
   */
  say(text: string, session?: string): Promise<SayOutcome> {
    const body = text.trim().slice(0, SEND_MAX);
    if (!body) return Promise.resolve({ ok: false, reason: 'empty message', code: 'empty' });
    if (!this.connected) return Promise.resolve({ ok: false, reason: 'unsent', code: 'unsent' });
    const target = typeof session === 'string' ? session.trim().slice(0, 128) : '';
    const id = `p${++this.seq}`;
    return new Promise<SayOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, reason: 'DSH did not answer in time', code: 'timeout' });
      }, 15_000);
      timer.unref?.();
      this.waiting.set(id, { resolve, timer });
      // `session` is only sent when there is one: a targetless line stays the exact old frame, so an
      // older Host sees nothing new.
      const frame = target ? { t: 'say', id, text: body, from: this.opts.name(), session: target } : { t: 'say', id, text: body, from: this.opts.name() };
      try {
        this.socket!.send(JSON.stringify(frame));
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve({ ok: false, reason: 'unsent', code: 'unsent' });
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

  /**
   * Every live DSH session, for an explicit picker. DSH emits no event when a person merely
   * switches tabs, so auto-follow cannot see silent navigation; listing plus `pick` replaces
   * mind-reading. Resolves `null` when the bridge is down, the Host is too old to answer, or the
   * answer misses `timeoutMs` — a caller polling for display wants to give up sooner than a
   * person waiting on a button.
   */
  listSessions(timeoutMs = 10_000): Promise<SessionList | null> {
    if (!this.connected) return Promise.resolve(null);
    if (this.waitingList) return this.waitingList.promise;
    let resolve!: (result: SessionList | null) => void;
    const promise = new Promise<SessionList | null>((r) => { resolve = r; });
    const timer = setTimeout(() => {
      this.waitingList = null;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    this.waitingList = { resolve, timer, promise };
    try {
      this.socket!.send(JSON.stringify({ t: 'list-sessions' }));
    } catch {
      clearTimeout(timer);
      this.waitingList = null;
      resolve(null);
    }
    return promise;
  }

  /**
   * The projects DSH would accept for a `new`, so the pet can name one instead of guessing a path.
   *
   * Resolves `null` when the bridge is down, the Host predates the frame, or no answer arrives in
   * time: a Host that stayed silent is not a Host with no workspaces, and the caller says which.
   */
  listWorkspaces(timeoutMs = 10_000): Promise<WorkspaceList | null> {
    if (!this.connected) return Promise.resolve(null);
    if (this.waitingWorkspaces) return this.waitingWorkspaces.promise;
    let resolve!: (result: WorkspaceList | null) => void;
    const promise = new Promise<WorkspaceList | null>((r) => { resolve = r; });
    const timer = setTimeout(() => {
      this.waitingWorkspaces = null;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    this.waitingWorkspaces = { resolve, timer, promise };
    try {
      this.socket!.send(JSON.stringify({ t: 'list-workspaces' }));
    } catch {
      clearTimeout(timer);
      this.waitingWorkspaces = null;
      resolve(null);
    }
    return promise;
  }

  /**
   * Drop the pin so the Host's own auto-follow owns the session again. Without this the pet keeps
   * speaking into a session the person believes it has let go of: the pin lives in the Host, so a
   * local-only "unbind" changes nothing but this panel. Resolves `null` when the pin is gone,
   * `'unsent'` when the bridge is down, or a reason.
   */
  unpin(): Promise<string | null> {
    if (!this.connected) return Promise.resolve('unsent');
    if (this.waitingUnpin) return Promise.resolve('an unpin request is already in flight');
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waitingUnpin = null;
        resolve('DSH did not answer in time');
      }, 10_000);
      timer.unref?.();
      this.waitingUnpin = { resolve, timer };
      try {
        this.socket!.send(JSON.stringify({ t: 'unpin' }));
      } catch {
        clearTimeout(timer);
        this.waitingUnpin = null;
        resolve('unsent');
      }
    });
  }

  /**
   * Start a new DSH conversation and point this pet at it. The Host makes one when the person
   * archived every session, so the pet is not left with nowhere to speak; the answer carries the
   * session id, and the `ready` frame that follows does the binding.
   *
   * `workspace` names the project the conversation belongs in — an id, or a path the person said
   * out loud. A Host that predates the field ignores it and answers with no `workspace` at all,
   * which is why the answer carries the one it actually used: silence is not consent.
   *
   * Resolves `{ ok: false, reason: 'unsent' }` when the bridge is down, so the caller can say the
   * request never left instead of reporting a failure that may not have happened.
   */
  newSession(workspace?: string): Promise<NewSessionOutcome> {
    if (!this.connected) return Promise.resolve({ ok: false, reason: 'unsent' });
    const id = `n${++this.seq}`;
    const target = typeof workspace === 'string' ? workspace.trim() : '';
    return new Promise<NewSessionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waitingNew.delete(id);
        resolve({ ok: false, reason: 'DSH did not answer in time' });
      }, 20_000);
      timer.unref?.();
      this.waitingNew.set(id, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify(target ? { t: 'new', id, workspace: target.slice(0, 512) } : { t: 'new', id }));
      } catch {
        clearTimeout(timer);
        this.waitingNew.delete(id);
        resolve({ ok: false, reason: 'unsent' });
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
        this.opts.onState(true, {
          session: frame.session,
          cwd: frame.cwd,
          model: frame.model,
          sessions: frame.sessions,
          pinned: frame.pinned,
        });
        this.remember(frame.sessions);
        return;
      }
      if (frame.t === 'accepted' || frame.t === 'refused') {
        // A `refused` frame without an id answers a `pick` or an `unpin`, not a `say`.
        if (frame.t === 'refused' && !('id' in frame)) {
          const pick = [...this.waitingPick.values()][0];
          if (pick) {
            clearTimeout(pick.timer);
            this.waitingPick.clear();
            pick.resolve(frame.reason);
            return;
          }
          const unpin = this.waitingUnpin;
          if (unpin) {
            this.waitingUnpin = null;
            clearTimeout(unpin.timer);
            unpin.resolve(frame.reason);
          }
          return;
        }
        const answerId = (frame as { id: string }).id;
        // A refused `new` carries the request id too; check before treating it as a `say` answer.
        const created = this.waitingNew.get(answerId);
        if (created) {
          clearTimeout(created.timer);
          this.waitingNew.delete(answerId);
          created.resolve({ ok: false, reason: (frame as { reason?: string }).reason ?? 'DSH refused to create a conversation' });
          return;
        }
        const entry = this.waiting.get(answerId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waiting.delete(answerId);
        // The ack repeats where the words went and what else was open, so the caller can show the
        // landing spot and recover from a refusal without a second round trip. A Host before 0.2.20
        // sends neither, which reads the same as "the words were accepted somewhere".
        this.remember(frame.sessions);
        if (frame.t === 'accepted') {
          entry.resolve({ ok: true, session: frame.session, sessions: frame.sessions, pinned: frame.pinned });
        } else {
          entry.resolve({ ok: false, reason: frame.reason, code: frame.code, sessions: frame.sessions, pinned: frame.pinned });
        }
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
      if (frame.t === 'session-list') {
        // A pushed list arrives with no request waiting on it; the list in hand is still updated, so
        // the next line can name a conversation without asking again.
        this.remember(frame.sessions);
        const entry = this.waitingList;
        this.waitingList = null;
        if (entry) {
          clearTimeout(entry.timer);
          entry.resolve({ sessions: frame.sessions, pinned: frame.pinned, owner: frame.owner });
        }
        return;
      }
      if (frame.t === 'workspace-list') {
        const entry = this.waitingWorkspaces;
        this.waitingWorkspaces = null;
        if (entry) {
          clearTimeout(entry.timer);
          entry.resolve({ workspaces: frame.workspaces });
        }
        return;
      }
      if (frame.t === 'unpinned') {
        const entry = this.waitingUnpin;
        this.waitingUnpin = null;
        if (entry) {
          clearTimeout(entry.timer);
          entry.resolve(null);
        }
        return;
      }
      if (frame.t === 'created') {
        const entry = this.waitingNew.get(frame.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waitingNew.delete(frame.id);
        entry.resolve({ ok: true, session: frame.session, workspace: frame.workspace });
        return;
      }
      // A Host that cannot answer a listing says so with an `error` frame instead of the list. That
      // is an answer: resolve the waiting caller now (null = do not know) and log the Host's own
      // words, instead of letting the request sit out its whole timeout and read as "DSH is slow".
      if (frame.t === 'error' && (this.waitingList || this.waitingWorkspaces)) {
        if (this.waitingList) {
          const entry = this.waitingList;
          this.waitingList = null;
          clearTimeout(entry.timer);
          this.opts.log('warn', `DSH bridge answered a session listing with: ${frame.text}`);
          entry.resolve(null);
        }
        if (this.waitingWorkspaces) {
          const entry = this.waitingWorkspaces;
          this.waitingWorkspaces = null;
          clearTimeout(entry.timer);
          this.opts.log('warn', `DSH bridge answered a workspace listing with: ${frame.text}`);
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

/**
 * The session rows inside a frame, tolerating anything a Host may omit.
 *
 * A row without an id is not a conversation anyone can name, so it is dropped rather than listed;
 * everything else defaults, because `cwd`, `title`, `model` and the flags only decorate the row.
 */
function sessionRows(value: unknown): SessionRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SessionRow[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) continue;
    const title = typeof row.title === 'string' ? row.title : '';
    rows.push({
      id,
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      model: typeof row.model === 'string' ? row.model : '',
      // A Host older than 0.2.22 sends no title at all; keep the key out then, so a reader can
      // tell "this Host cannot tell me" from "this conversation has no name yet".
      ...(title === '' ? {} : { title }),
      // Same rule for `running`: a Host older than 0.2.23 cannot answer, and claiming "idle" on its
      // behalf would tell the bot a conversation is free when nobody knows whether it is.
      ...(typeof row.running === 'boolean' ? { running: row.running } : {}),
      owner: row.owner === true,
      pinned: row.pinned === true,
      subagent: row.subagent === true,
    });
  }
  return rows;
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
      // From connector 0.2.20 the list rides along; an older Host simply has no `sessions` key.
      const sessions = Array.isArray(frame.sessions) ? sessionRows(frame.sessions) : undefined;
      const pinned = typeof frame.pinned === 'boolean' ? frame.pinned : undefined;
      return {
        t: 'ready',
        v,
        session,
        cwd: str('cwd') ?? '',
        model: str('model') ?? '',
        ...(sessions ? { sessions } : {}),
        ...(pinned === undefined ? {} : { pinned }),
      };
    }
    case 'turn-start': {
      const turn = num('turn');
      return turn === null ? null : { t: 'turn-start', turn };
    }
    case 'turn-end': {
      const turn = num('turn');
      if (turn === null) return null;
      const used = num('used');
      const size = num('size');
      return used !== null && size !== null && size > 0
        ? { t: 'turn-end', turn, reason: str('reason') ?? 'completed', used, size }
        : { t: 'turn-end', turn, reason: str('reason') ?? 'completed' };
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
      if (text === null) return null;
      const callId = str('callId');
      return callId === null ? { t: 'question', text } : { t: 'question', text, callId };
    }
    case 'question-end': {
      const callId = str('callId');
      return callId === null ? null : { t: 'question-end', callId };
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
      const sessions = Array.isArray(frame.sessions) ? sessionRows(frame.sessions) : undefined;
      const pinned = typeof frame.pinned === 'boolean' ? frame.pinned : undefined;
      const carried = { ...(sessions ? { sessions } : {}), ...(pinned === undefined ? {} : { pinned }) };
      if (frame.t === 'accepted') {
        const landed = str('session');
        return { t: 'accepted', id, ...(landed === null ? {} : { session: landed }), ...carried };
      }
      const code = str('code');
      return { t: 'refused', id, reason: str('reason') ?? '', ...(code === null ? {} : { code }), ...carried };
    }
    case 'picked': {
      const session = str('session');
      return session === null ? null : { t: 'picked', session };
    }
    case 'session-list': {
      if (!Array.isArray(frame.sessions)) return null;
      // Same reader as the acks use: one place that knows how a row is spelled, so a field added
      // to one path cannot go missing on the other (a pushed list would otherwise lose its titles).
      return { t: 'session-list', sessions: sessionRows(frame.sessions), pinned: frame.pinned === true };
    }
    case 'unpinned':
      return { t: 'unpinned' };
    case 'workspace-list': {
      if (!Array.isArray(frame.workspaces)) return null;
      const workspaces: WorkspaceList['workspaces'] = [];
      for (const entry of frame.workspaces) {
        if (typeof entry !== 'object' || entry === null) continue;
        const row = entry as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id : '';
        if (!id) continue;
        workspaces.push({
          id,
          path: typeof row.path === 'string' ? row.path : '',
          sessions: typeof row.sessions === 'number' && Number.isFinite(row.sessions) ? row.sessions : 0,
          owner: row.owner === true,
        });
      }
      return { t: 'workspace-list', workspaces };
    }
    case 'created': {
      const id = str('id');
      const session = str('session');
      return id === null || session === null ? null : { t: 'created', id, session, workspace: str('workspace') ?? undefined };
    }
    default:
      return null;
  }
}
