/**
 * The Fatfish World: one pack that both speaks for the pet and bridges it to DeepSeek Harness.
 *
 * One scan per tick serves both halves from the same event store: the pet's own lines go to the
 * speaker (and, when `relayPet` is on, to the bridge), the person's typed and voice-transcribed
 * lines go to the DSH bridge. Each half keeps its own cursor, and both start at the newest event:
 * a restart replays nothing and hands over nothing said before it started. A line that arrives
 * while the bridge is down waits in a small queue and is handed over once the bridge comes back.
 *
 * The bridge half owns one WebSocket to the Host half (`packages/coopanion-connector-dsh`). DSH
 * notices arrive as events for the bot to judge, and the only word this World ever says on its own
 * is the receipt that a line was already handed over. The voice half has no words of its own: the
 * speech is the bubble's echo, and its only tool stops it — the one playing and the queued ones.
 */
import type { Language } from 'cortico/core/language.ts';
import type {
  EventEnvelope,
  ToolDef,
  World,
  WorldHost,
  WorldPanelDecl,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshClient, PROTOCOL_VERSION, type HostFrame } from './client.ts';
import { speakable } from './clean.ts';
import {
  DEFAULT_URL,
  FATFISH_ID,
  RELAY_MAX,
  SEND_MAX,
  fatfishConfigGroups,
  resolveSpeak,
  type FatfishConfigSection,
} from './config.ts';
import { discoverBridge } from './discover.ts';
import { fatfishText, type FatfishText } from './i18n/index.ts';
import { Speaker, type SpeakOptions } from './speaker.ts';

/** The event type a person's line carries; the pet World owns the type, this World only reads it. */
const PERSON_EVENT = 'desktop-pet.message';
/** The voice-transcribed person's line; read the same way as a typed one. */
const SPEECH_EVENT = 'desktop-pet.speech';
/** The pet's own lines; the pet World owns the type, this World only reads them. */
const SELF_TYPE = 'desktop-pet.self';
/** The most events one scan reads; it reads the in-process event store, not the disk. */
const SCAN_LIMIT = 50;
/** The scan cadence; it reads the in-process event store, not the disk. */
const SCAN_MS = 1500;
/** The person's lines that may wait for the bridge while it is down; beyond this the oldest drops. */
const PENDING_MAX = 16;
/** How long after startup the bridge still queues lines for a DSH that has never shown up. */
const GRACE_MS = 30_000;
/** The quiet period after a successful sweep; a Host that stays put is not re-found on every retry. */
const DISCOVER_COOLDOWN_MS = 20_000;
/** The first gap after a sweep that found nothing; doubles up to the ceiling below. */
const DISCOVER_RETRY_MS = 3_000;
/** The longest gap between sweeps while no Host is up, so a late-starting DSH is still found. */
const DISCOVER_MAX_MS = 30_000;
/** The file in the data directory that remembers the port the Host last answered on. */
const BRIDGE_CACHE = 'fatfish-bridge.json';
/** A remembered port older than this is not worth dialling first. */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface FatfishWorldOptions {
  /** The live `worlds.fatfish` section. */
  cfg: FatfishConfigSection;
  /** The app language, read at each use. */
  language?(): Language;
  /** The name this pet gives DSH. */
  name?(): string;
  /**
   * A directory this World may keep small state in across runs. The remembered Host port lives
   * here, so a restart of the app can skip the sweep while DSH is still on the same port. Absent
   * in tests and in hosts that hand out no directory: nothing is remembered then.
   */
  stateDir?: string;
  /**
   * Look for the Host on loopback when the address we hold stops answering. On by default: DSH picks
   * its port at launch, so a configured URL outlives it. A test that has to own the exact address
   * turns it off rather than let whichever Host this machine runs shadow its own listener.
   */
  discover?: boolean;
}

/** The text one self event reads as; empty for events that say nothing speakable. */
export function lineOf(event: EventEnvelope, readOptions: boolean): string {
  const meta = (event.meta ?? {}) as Record<string, unknown>;
  if (meta.kind === 'say' && Array.isArray(meta.beats)) {
    const beats = (meta.beats as Array<Record<string, unknown>>)
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean);
    return speakable(beats.join('。 '));
  }
  if (meta.kind === 'ask' && typeof meta.question === 'string') {
    const question = speakable(meta.question);
    if (!question) return '';
    const options = readOptions === false || !Array.isArray(meta.options)
      ? []
      : meta.options.filter((o): o is string => typeof o === 'string' && !!speakable(o));
    return options.length ? `${question}。 可选：${options.map((o) => speakable(o)).join('；')}` : question;
  }
  return '';
}

/** Whether a workspace name the model wrote is a path, rather than an id the Host resolves. */
function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
}

/** Do two workspace paths name the same directory on this platform? */
function sameWorkspacePath(a: string, b: string): boolean {
  const key = (value: string): string => {
    const trimmed = value.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return key(a) === key(b);
}

/** The environment prompt template; its `{{...}}` holes are filled from `envPromptVars()`. */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class FatfishWorld implements World {
  readonly id = FATFISH_ID;
  private host: WorldHost | null = null;
  private client: DshClient | null = null;
  private connected = false;
  private session = '';
  private model = '';
  /** Where the voice half has read to; it starts at the newest event, so a restart replays nothing. */
  private voiceCursor = 0;
  /** Where the bridge half has read to; it starts at the newest event, so a restart hands over nothing old. */
  private bridgeCursor = 0;
  /** The person's lines already handed to DSH, by the cursor of the line's own event. */
  private readonly handedOver = new Set<number>();
  /** The person's lines waiting for the bridge to come back; capped at `PENDING_MAX`. */
  private readonly pending: Array<{ text: string; cursor: number }> = [];
  /** True once the bridge has actually connected in this run; queueing only makes sense then. */
  private everConnected = false;
  /** Until when a never-connected bridge still queues lines, in case DSH starts a little late. */
  private graceUntil = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly speaker = new Speaker();
  /** Serialises speech: one clip at a time, the next starting as this one ends. */
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by `tts_hush`; a queued line whose epoch has moved on is dropped instead of spoken. */
  private speechEpoch = 0;
  /** How many lines sit in the speech chain, waiting for their turn. */
  private queuedSpeech = 0;
  private speaking = false;
  private failed = false;
  /** The address discovery last found; it wins over the configured URL while DSH stays where it is. */
  private discoveredUrl: string | null = null;
  /** True while a sweep is in flight, so the reconnect loop cannot stack sweeps. */
  private discovering = false;
  /** Earliest moment the next sweep may start; a Host that was found waits longer than a missing one. */
  private nextSweepAt = 0;
  /** The gap that follows a sweep that found nothing; it doubles up to `DISCOVER_MAX_MS`. */
  private sweepWait = DISCOVER_RETRY_MS;
  /** Where the last good port is remembered; null when no directory was handed in. */
  private readonly cachePath: string | null;
  /** False once stop() ran, so a sweep still in flight does not revive a World that is leaving. */
  private running = false;
  /** When set, the pet refuses to follow the default owner and stays on this session. */
  private pinnedSession: string | null = null;
  /** The address the live socket actually dialled; sampled when the socket was created, so a
   *  rediscover that clears the hint cannot rewrite history. */
  private connectedUrl: string | null = null;
  /** The target handed to DshClient on its last connect() attempt. */
  private dialingUrl: string | null = null;

  constructor(private readonly opts: FatfishWorldOptions) {
    this.cachePath = opts.stateDir ? join(opts.stateDir, BRIDGE_CACHE) : null;
  }

  private get t(): FatfishText {
    return fatfishText(this.opts.language?.() ?? 'zh');
  }

  /** The URL the person configured, or the shipped default when they left it empty. */
  private get configuredUrl(): string {
    const url = this.opts.cfg.url;
    return typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_URL;
  }

  /** The address to dial: whatever discovery last found, else the configured one. */
  private get url(): string {
    return this.discoveredUrl ?? this.configuredUrl;
  }

  /** The configured URL with only its port replaced; host, path and query stay as the person set them. */
  private urlAtPort(port: number): string {
    try {
      const next = new URL(this.configuredUrl);
      next.port = String(port);
      return next.toString();
    } catch {
      return `ws://127.0.0.1:${port}/coopanion/pet`;
    }
  }

  /**
   * Looks for the Host on loopback when the address we hold stops answering, and once at startup.
   *
   * DSH picks its web port at launch, so a configured URL outlives the port it names. A sweep that
   * finds nothing waits a little and comes back with a longer gap, so a DSH that is still booting
   * is caught within seconds instead of after a retry cycle; a sweep that found the Host waits
   * longer. `force` ignores that pacing for the startup sweep, whose whole point is to answer
   * before the first dial fails.
   */
  private async rediscover(force = false): Promise<void> {
    const host = this.host;
    if (!this.running || !host || this.discovering) return;
    // The address discovery found is not answering either, or we would not be here: fall back to
    // the configured one for the retries in between, and let the sweep below look for where the
    // Host went. A discovered address is a hint about the past, not a replacement for the config.
    this.discoveredUrl = null;
    if (!force && Date.now() < this.nextSweepAt) return;
    this.discovering = true;
    try {
      const found = await discoverBridge({ version: PROTOCOL_VERSION, shouldStop: () => !this.running });
      if (!found || !this.running || this.connected) return;
      this.rememberPort(found.port);
      const next = this.urlAtPort(found.port);
      // The config already names the Host's port: the dial that just failed is not about a moved
      // port, so leave the pacing to the retry path below.
      if (next === this.configuredUrl) return;
      this.sweepWait = DISCOVER_RETRY_MS;
      this.nextSweepAt = Date.now() + DISCOVER_COOLDOWN_MS;
      this.discoveredUrl = next;
      host.log.info(`DSH bridge moved to 127.0.0.1:${found.port}, reconnecting`);
      this.client?.retryNow();
    } catch {
      // A sweep that throws is a sweep that found nothing; the retry loop will come back to it.
    } finally {
      this.discovering = false;
      if (!this.discoveredUrl && this.running && !this.connected) {
        // Nothing to dial: come back sooner than a full retry cycle, but not so soon that a DSH
        // nobody started keeps a sweep running half the time.
        this.sweepWait = Math.min(this.sweepWait * 2, DISCOVER_MAX_MS);
        this.nextSweepAt = Date.now() + this.sweepWait;
      }
    }
  }

  /** Remembers the port the Host answered on, so the next start can dial it before sweeping. */
  private rememberPort(port: number): void {
    if (!this.cachePath || !Number.isInteger(port) || port < 1) return;
    try {
      writeFileSync(this.cachePath, JSON.stringify({ lastGoodPort: port, seenAt: Date.now() }));
    } catch {
      // A missing or read-only directory only costs the next start one sweep.
    }
  }

  /** The remembered port, when it is recent enough to be worth dialling first; 0 otherwise. */
  private recalledPort(): number {
    if (!this.cachePath) return 0;
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as { lastGoodPort?: unknown; seenAt?: unknown };
      const port = typeof raw.lastGoodPort === 'number' ? raw.lastGoodPort : 0;
      const seenAt = typeof raw.seenAt === 'number' ? raw.seenAt : 0;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return 0;
      return Date.now() - seenAt > CACHE_MAX_AGE_MS ? 0 : port;
    } catch {
      return 0;
    }
  }

  /** The port a URL names; 0 when it names none or does not parse. */
  private static portOf(url: string): number {
    try {
      const parsed = new URL(url);
      if (parsed.port) return Number(parsed.port);
      return parsed.protocol === 'wss:' ? 443 : 80;
    } catch {
      return 0;
    }
  }

  private get voice(): SpeakOptions {
    return resolveSpeak(this.opts.cfg);
  }

  async start(host: WorldHost): Promise<void> {
    this.running = true;
    this.host = host;
    this.graceUntil = Date.now() + GRACE_MS;
    const latest = host.store.latestCursor();
    this.voiceCursor = latest;
    this.bridgeCursor = latest;
    host.log.info(`fatfish armed, voice=${this.voice.voice}, voiceCursor=${this.voiceCursor}, bridgeCursor=${this.bridgeCursor}`);
    if (this.opts.cfg.bridgeEnabled !== false) {
      // DSH keeps the port it picked across a restart of this app, so the remembered one is dialled
      // first; a stale one costs a single refused connection before the sweep takes over.
      const recalled = this.recalledPort();
      if (recalled) {
        const hint = this.urlAtPort(recalled);
        if (hint !== this.configuredUrl) this.discoveredUrl = hint;
      }
      const client = new DshClient({
        url: () => {
          const target = this.url;
          this.dialingUrl = target;
          return target;
        },
        name: () => this.opts.name?.() ?? 'Coopanion',
        onFrame: (frame) => void this.onFrame(frame),
        onState: (connected, session) => {
          this.connected = connected;
          this.session = session?.session ?? '';
          this.model = session?.model ?? '';
          if (!connected) this.connectedUrl = null;
          if (connected) {
            this.everConnected = true;
            this.connectedUrl = this.dialingUrl ?? this.url;
            this.rememberPort(FatfishWorld.portOf(this.connectedUrl));
            host.log.info(`DSH bridge connected: session ${session?.session ?? ''}`);
            this.flushPending();
            // A pinned session may no longer be the Host's default owner after a reconnect or
            // pick-free switch; re-pick to stay on target. The first ready that comes while
            // `start()` is still running sees this too, but the client is only re-hung, so
            // pick fires after the bridge is fully up.
            if (this.pinnedSession && session?.session && this.pinnedSession !== session.session) {
              void this.client?.pick(this.pinnedSession).then((refusal) => {
                if (refusal) {
                  host.log.warn(`DSH bridge pinned session gone: ${refusal}`);
                  this.pinnedSession = null;
                }
              });
            }
          } else if (this.opts.discover !== false) {
            void this.rediscover();
          }
        },
        log: (level, text) => {
          if (level === 'warn') host.log.warn(text);
          else host.log.info(text);
        },
      });
      this.client = client;
      client.start();
      // The configured URL may already name a port DSH has left. Look while the first dial runs,
      // rather than wait for it to fail and then for a sweep: that wait is what made a restarted
      // DSH unreachable for the better part of a minute.
      if (this.opts.discover !== false) void this.rediscover(true);
    }
    this.scanTimer = setInterval(() => void this.scan(), SCAN_MS);
    this.scanTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.client?.stop();
    this.client = null;
    this.connected = false;
    this.pending.length = 0;
    this.speechEpoch++;
    this.queuedSpeech = 0;
    await this.speaker.stop();
    this.host = null;
  }

  /**
   * One scan serves both halves. Both cursors start at the newest event, so only lines said after
   * this World started are picked up — a restart replays nothing and hands over nothing old.
   */
  private async scan(): Promise<void> {
    const host = this.host;
    if (!host) return;
    let events: EventEnvelope[];
    try {
      events = host.store.range({ fromCursor: Math.min(this.voiceCursor, this.bridgeCursor) + 1, limit: SCAN_LIMIT });
    } catch {
      return;
    }
    for (const event of events) {
      this.voiceCursor = Math.max(this.voiceCursor, event.cursor);
      this.bridgeCursor = Math.max(this.bridgeCursor, event.cursor);
      if (event.type === PERSON_EVENT || event.type === SPEECH_EVENT) {
        this.relay(event);
        continue;
      }
      if (event.type === SELF_TYPE) {
        const line = lineOf(event, this.opts.cfg.readOptions !== false);
        if (!line) continue;
        if (this.opts.cfg.relayPet === true) this.relaySelf(line, event.cursor);
        host.log.info(`fatfish speaking: ${line.slice(0, 60)}`);
        this.enqueue(line);
      }
    }
  }

  /**
   * One of the person's lines towards DSH, behind the guards that keep the two mouths from looping.
   * A typed line and a voice-transcribed one read the same; both carry the text in `meta.text`.
   */
  private relay(event: EventEnvelope): void {
    if (this.opts.cfg.relayPerson === false || !this.client) return;
    if (this.handedOver.has(event.cursor)) return;
    const meta = (event.meta ?? {}) as { via?: unknown; text?: unknown; relayed?: unknown };
    // A line this bridge put there came from DSH; sending it back would loop the two mouths.
    if (meta.relayed === true || meta.via === 'dsh') return;
    const text = typeof meta.text === 'string' ? meta.text : event.text;
    if (!text) return;
    void this.sayToDsh(text, event.cursor);
  }

  /**
   * One of the pet's own lines towards DSH, when `relayPet` says so. The line reads the same way
   * the voice half reads it, so what DSH hears is what the bubble said.
   */
  private relaySelf(line: string, cursor: number): void {
    if (this.opts.cfg.relayPet !== true || !this.client) return;
    if (this.handedOver.has(cursor)) return;
    // Silent: the bot has no reason to re-send a line it did not speak, so a
    // receipt would only tempt it into commenting — the very loop `relayPet` risks.
    void this.sayToDsh(line, cursor, false);
  }

  /**
   * One notice for the bot to judge. A notice that cannot be stored is one the person never needed,
   * so the failure is swallowed rather than raised into the socket's message handler.
   */
  private pushNotice(text: string, meta: Record<string, unknown>): void {
    void this.host?.pushEvent(
      { type: `${FATFISH_ID}.notice`, source: FATFISH_ID, ts: new Date().toISOString(), text, meta },
      { trigger: 'flush' },
    ).catch(() => {});
  }

  /**
   * One of the person's lines into DSH, followed by a notice saying the bridge already carried it.
   *
   * Without that notice the bot sees the person's words arrive with no sign that DSH has them, and
   * hands the same line over again with `dsh_send`; DSH then wraps the copy in its own prefix, and
   * the person's one line sits in the conversation twice. A line that provably never left — the
   * bridge was down, the socket refused the write — waits in `pending` instead of being dropped; a
   * line whose fate is unknown (a timeout, a refusal) is reported to the bot, which can re-send it
   * with `dsh_send` if it judges the line never arrived. Receipts are optional (`announce`): the
   * pet's own lines ride silently, since the bot has nothing to re-send and a notice would only
   * invite it to comment.
   */
  private async sayToDsh(text: string, sourceCursor: number, announce = true): Promise<void> {
    const client = this.client;
    if (!client) return;
    const refusal = await client.say(text);
    if (refusal === null) {
      this.handedOver.add(sourceCursor);
      if (announce) {
        const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        this.pushNotice(`[DSH] 已把「${shown}」转交给 DSH，不必再转一次。`, { kind: 'relayed', text, cursor: sourceCursor });
      }
      return;
    }
    if (refusal === 'unsent') {
      this.hold(text, sourceCursor);
      return;
    }
    if (announce) {
      this.pushNotice(`[DSH] 有一句没有转交成功（${refusal}）。它可能已到达也可能没有；若你认为没到，可用 dsh_send 重发。`, { kind: 'relay-failed', text, cursor: sourceCursor });
    }
  }

  /**
   * One line aside for when the bridge is back; the oldest drops once the queue is full.
   *
   * Queueing only makes sense while a late-starting DSH may still show up (the grace window), or
   * once the bridge has actually connected in this run and could come back. With no DSH installed
   * or enabled, the bridge never connects and voice-only users would pile up sixteen lines and
   * then collect a "dropped" notice per line spoken — so past the grace window, a never-connected
   * bridge lets the line go silently: no queue, no notice, no flush waking the bot.
   */
  private hold(text: string, cursor: number): void {
    if (this.handedOver.has(cursor) || this.pending.some((p) => p.cursor === cursor)) return;
    if (!this.everConnected && Date.now() >= this.graceUntil) return;
    this.pending.push({ text, cursor });
    while (this.pending.length > PENDING_MAX) {
      const dropped = this.pending.shift()!;
      this.pushNotice(`[DSH] 待转交的句子已积到 ${PENDING_MAX} 条，最早的一句被丢下：${dropped.text.slice(0, 60)}`, { kind: 'relay-dropped', text: dropped.text, cursor: dropped.cursor });
    }
  }

  /** The lines the bridge could not carry while it was down, handed over oldest first. */
  private flushPending(): void {
    const waiting = this.pending.splice(0, this.pending.length);
    for (const { text, cursor } of waiting) {
      if (this.handedOver.has(cursor)) continue;
      void this.sayToDsh(text, cursor);
    }
  }

  /** One notice from DSH, turned into an event for the bot to judge. */
  private async onFrame(frame: HostFrame): Promise<void> {
    if (!this.host) return;
    const push = (text: string, meta: Record<string, unknown>): void => this.pushNotice(text, meta);
    switch (frame.t) {
      case 'turn-start':
        push(`[DSH] 第 ${frame.turn} 轮开始。`, { kind: 'turn-start', turn: frame.turn });
        return;
      case 'turn-end':
        push(`[DSH] 第 ${frame.turn} 轮结束（${frame.reason}）。`, { kind: 'turn-end', turn: frame.turn, reason: frame.reason });
        return;
      case 'reply': {
        const text = frame.text.length > RELAY_MAX ? `${frame.text.slice(0, RELAY_MAX)}…` : frame.text;
        push(`[DSH] 回复：${text}`, { kind: 'reply', turn: frame.turn });
        return;
      }
      case 'tool':
        push(`[DSH] 调用工具 ${frame.name}${frame.detail ? `，参数 ${frame.detail}` : ''}。`, { kind: 'tool', name: frame.name });
        return;
      case 'approval':
        push(`[DSH] 正在等你批准 ${frame.name}${frame.reason ? `：${frame.reason}` : ''}。`, { kind: 'approval', name: frame.name });
        return;
      case 'question':
        push(`[DSH] 正在等你回答：${frame.text}`, { kind: 'question' });
        return;
      case 'error':
        push(`[DSH] 出错：${frame.text}`, { kind: 'error' });
        return;
      case 'ready':
      case 'accepted':
      case 'refused':
        return;
    }
  }

  /** Hands one line to the speech chain; returns at once, the line speaks when its turn comes. */
  private enqueue(line: string): void {
    const epoch = this.speechEpoch;
    this.queuedSpeech++;
    this.chain = this.chain
      .then(() => {
        // A hush bumped the epoch while this line waited; it is dropped, not spoken.
        if (epoch !== this.speechEpoch) return;
        this.queuedSpeech = Math.max(0, this.queuedSpeech - 1);
        return this.say(line);
      })
      .catch(() => {});
  }

  private async say(line: string): Promise<void> {
    const host = this.host;
    if (!host || this.opts.cfg.ttsEnabled === false) return;
    this.speaking = true;
    try {
      const spoken = await this.speaker.speak(line, this.voice, (text) => host.log.info(text));
      host.log.info(spoken ? 'fatfish played' : 'fatfish skipped (cooldown/off-platform)');
      this.failed = !spoken;
    } finally {
      this.speaking = false;
    }
  }

  tools(): ToolDef[] {
    const t = this.t.model;
    return [
      {
        name: 'dsh_send',
        description: [
          'Hand one line to the DeepSeek Harness conversation this pet is bridged to; DSH treats it as a message from the person.',
          this.opts.cfg.relayPerson !== false
            ? 'The person\'s own lines reach DSH through the bridge itself, and the notice that follows one says it arrived; hand over a line only when you have seen no such notice.'
            : 'The person\'s own lines do not reach DSH on their own: hand over the ones that belong in that conversation, in their own words where you have them.',
          'DSH writes the pet\'s name in a prefix of its own, so text that already carries one arrives inside a second.',
          'The receipt says whether DSH accepted it. Do not call it to narrate what you are doing.',
        ].join(' '),
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: SEND_MAX, description: 'What to hand over, in the person\'s own words where you have them.' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          const text = typeof args.text === 'string' ? args.text : '';
          if (!text.trim()) return t.sendFailed.replace('{reason}', 'empty message');
          if (!this.client) return t.sendFailed.replace('{reason}', t.notConnected);
          const refusal = await this.client.say(text);
          return refusal === null ? t.sent : t.sendFailed.replace('{reason}', refusal);
        },
      },
      {
        name: 'dsh_pick_session',
        description: [
          'Point this pet at a different DeepSeek Harness session, by its id.',
          'By default the pet follows the newest open conversation; use this when the person wants your words to go into an older one (for example after archiving the current session).',
          'It only accepts a session that is still open on the DSH side; a closed or unknown id is refused.',
        ].join(' '),
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            session: { type: 'string', maxLength: 128, description: 'The id of the DSH session to speak into.' },
          },
          required: ['session'],
        },
        handler: async (args) => {
          const session = typeof args.session === 'string' ? args.session : '';
          if (!session.trim()) return '未指定会话 id。';
          if (!this.client) return t.notConnected;
          const refusal = await this.client.pick(session);
          return refusal === null ? `已切换到 DSH 会话 ${session}。` : `切换失败：${refusal}`;
        },
      },
      {
        name: 'dsh_new_session',
        description: [
          'Start a new DeepSeek Harness conversation and point this pet at it.',
          'Use it when the person asks for a new session, when DSH has no open conversation — for example after they archived them all, which makes dsh_send refuse with "no conversation is open on the DSH side" — or when the work belongs in a different project.',
          'Pass `workspace` with a path or an id from dsh_workspaces to put the conversation in that project; without it the Host uses the current conversation\'s workspace.',
          'The receipt names the new session and the workspace it landed in; words you hand over afterwards go there.',
        ].join(' '),
        tags: ['speak'],
        parameters: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              maxLength: 512,
              description: 'Path or id of the DSH workspace to start the conversation in. Omit to stay in the current one.',
            },
          },
        },
        handler: async (args) => {
          if (!this.client) return t.newSessionFailed.replace('{reason}', t.notConnected);
          const requested = typeof args.workspace === 'string' ? args.workspace.trim() : '';
          const outcome = await this.client.newSession(requested ? requested : undefined);
          if (!outcome.ok) {
            return t.newSessionFailed.replace('{reason}', outcome.reason === 'unsent' ? t.notConnected : outcome.reason);
          }
          // The Host binds as it creates; clearing the pin keeps a stale "hold this one" from
          // pulling the pet back to the conversation the person just replaced.
          this.pinnedSession = null;
          this.session = outcome.session;
          if (!requested) return t.newSessionDone.replace('{session}', outcome.session);
          // A Host from before this field ignores the request and answers with no workspace at all:
          // report that, instead of a success the caller has no way to check.
          if (!outcome.workspace) return t.newSessionUnverified.replace('{session}', outcome.session);
          if (!looksLikePath(requested) || sameWorkspacePath(outcome.workspace, requested)) {
            return t.newSessionDoneIn.replace('{session}', outcome.session).replace('{workspace}', outcome.workspace);
          }
          return t.newSessionMismatch
            .replace('{session}', outcome.session)
            .replace('{workspace}', outcome.workspace)
            .replace('{requested}', requested);
        },
      },
      {
        name: 'dsh_workspaces',
        description: [
          'List the DeepSeek Harness projects (workspaces) this pet may start a conversation in.',
          'Each row carries a path, an id and how many conversations are open in it; pass either the path or the id as `workspace` to dsh_new_session.',
          'Ask for it before moving work to another project, so the name you pass is one DSH actually has.',
        ].join(' '),
        tags: ['speak'],
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          if (!this.client) return t.workspacesFailed.replace('{reason}', t.notConnected);
          const list = await this.client.listWorkspaces();
          if (!list) return t.workspacesFailed.replace('{reason}', 'DSH did not answer the workspace list');
          if (list.workspaces.length === 0) return t.workspacesEmpty;
          const rows = list.workspaces.map((workspace) =>
            `- ${workspace.path}  id=${workspace.id}  open=${workspace.sessions}${workspace.owner ? '  (current)' : ''}`);
          return t.workspacesDone.replace('{list}', rows.join('\n'));
        },
      },
      {
        name: 'tts_hush',
        description: [
          'Stop the voice that reads your replies aloud, right now.',
          'Call it when the person asks for silence, asks you to skip the rest of what you were saying, or before a long stretch of quiet work.',
          'It stops the line being spoken and drops the lines still queued; nothing queued after it is spoken.',
          'It affects only the sound; the bubble text is untouched.',
        ].join(' '),
        tags: ['speak'],
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const wasSpeaking = this.speaking;
          const wasQueued = this.queuedSpeech > 0;
          this.speaker.hush();
          this.speechEpoch++;
          this.queuedSpeech = 0;
          return wasSpeaking || wasQueued ? this.t.hush.stopped : this.t.hush.nothing;
        },
      },
    ];
  }

  envPromptVars(): Record<string, string> {
    const t = this.t.model;
    const on = this.opts.cfg.ttsEnabled !== false;
    return {
      'dsh.status': !this.client
        ? 'off'
        : this.connected
          ? t.statusConnected.replace('{session}', this.session).replace('{model}', this.model || '—')
          : t.statusOffline,
      'tts.status': !on
        ? 'off'
        : this.failed
          ? 'error'
          : this.speaking
            ? 'speaking'
            : 'ready',
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = fatfishText(language);
    return {
      label: t.label,
      lamps: [
        {
          label: t.lamps.bridge,
          state: this.connected ? 'online' : 'offline',
          hint: this.connected ? t.lamps.connected : t.lamps.offline,
        },
        {
          label: t.lamps.speech,
          state: this.opts.cfg.ttsEnabled === false ? 'offline' : this.failed ? 'error' : this.speaking ? 'loading' : 'online',
          hint: this.opts.cfg.ttsEnabled === false ? t.lamps.idle : this.failed ? t.lamps.failed : this.speaking ? t.lamps.speaking : t.lamps.idle,
        },
      ],
      panels: panelDecls(),
      config: fatfishConfigGroups(language),
      promptDocs: [
        {
          key: `worlds.${FATFISH_ID}.envPrompt`,
          title: `${t.label} · 环境提示词`,
          description: 'DSH 桥接与语音朗读的常驻事实，以及两种状态的当前值。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'dsh.status', description: '桥接此刻是否连接，连接时带会话与模型名。' },
            { name: 'tts.status', description: '朗读此刻是待命、正在朗读、出错还是关闭。' },
          ],
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== 'dsh') throw new Error(`unknown panel ${panel}`);
        if (method === 'state') {
          // DSH sends nothing when a person merely switches tabs, so a polled state would keep
          // showing the session this World connected with. Ask the Host for its real owner first.
          if (this.client && this.connected) await this.syncOwner();
          return this.state();
        }
        if (method === 'new') {
          if (!this.client) throw new Error('DSH bridge not connected');
          const outcome = await this.client.newSession();
          if (!outcome.ok) throw new Error(outcome.reason);
          this.pinnedSession = null;
          this.session = outcome.session;
          return { ok: true, session: outcome.session };
        }
        if (method === 'listSessions') {
          if (!this.client || !this.connected) throw new Error('DSH bridge not connected');
          return this.client.listSessions();
        }
        if (method === 'bind') {
          const session = typeof args?.[0] === 'string' ? args[0].trim() : '';
          if (!session) throw new Error('no session id');
          if (!this.client || !this.connected) throw new Error('DSH bridge not connected');
          const refusal = await this.client.pick(session);
          if (refusal) throw new Error(refusal);
          this.pinnedSession = session;
          this.session = session;
          return { ok: true, session };
        }
        if (method === 'unbind') {
          // The pin lives in the Host, so clearing it here alone would leave the pet speaking into
          // the "released" session. Tell the Host, then forget it locally.
          if (this.client && this.connected) {
            const refusal = await this.client.unpin();
            if (refusal) throw new Error(refusal);
          }
          this.pinnedSession = null;
          return { ok: true };
        }
        throw new Error(`unknown ${panel}.${method}`);
      },
    };
  }

  /**
   * Take the Host's current owner as this World's session. Only a `ready` frame updates the
   * session otherwise, and DSH emits nothing when a person switches tabs without speaking — so a
   * polled panel would keep naming the conversation this World connected with.
   */
  private async syncOwner(): Promise<void> {
    const list = await this.client?.listSessions(2500);
    if (!list) return;
    const owner = list.sessions.find((s) => s.owner);
    if (!owner) return;
    this.session = owner.id;
    if (owner.model) this.model = owner.model;
  }

  /** What the WebUI page shows; the protocol revision is part of it so a mismatch is visible. */
  state(): Record<string, unknown> {
    return {
      connected: this.connected,
      url: this.connectedUrl ?? this.url,
      session: this.session,
      model: this.model,
      protocol: PROTOCOL_VERSION,
      pinned: this.pinnedSession,
    };
  }
}

/** One panel, with the state method the WebUI polls. */
function panelDecls(): WorldPanelDecl[] {
  return [{ id: 'dsh', title: 'DSH', getMethods: ['state'] }];
}
