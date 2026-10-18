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
import { fileURLToPath } from 'node:url';
import { DshClient, PROTOCOL_VERSION, type HostFrame } from './client.ts';
import { speakable } from './clean.ts';
import { DEFAULT_URL, FATFISH_ID, RELAY_MAX, SEND_MAX, fatfishConfigGroups, type FatfishConfigSection } from './config.ts';
import { fatfishText, type FatfishText } from './i18n/index.ts';
import { DEFAULT_VOICE } from './voices.ts';
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

export interface FatfishWorldOptions {
  /** The live `worlds.fatfish` section. */
  cfg: FatfishConfigSection;
  /** The app language, read at each use. */
  language?(): Language;
  /** The name this pet gives DSH. */
  name?(): string;
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

  constructor(private readonly opts: FatfishWorldOptions) {}

  private get t(): FatfishText {
    return fatfishText(this.opts.language?.() ?? 'zh');
  }

  private get url(): string {
    const url = this.opts.cfg.url;
    return typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_URL;
  }

  private get voice(): SpeakOptions {
    const cfg = this.opts.cfg;
    const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
    return {
      voice: str(cfg.voice, DEFAULT_VOICE),
      rate: str(cfg.rate, '+0%'),
      volume: str(cfg.volume, '+0%'),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const latest = host.store.latestCursor();
    this.voiceCursor = latest;
    this.bridgeCursor = latest;
    host.log.info(`fatfish armed, voice=${this.voice.voice}, voiceCursor=${this.voiceCursor}, bridgeCursor=${this.bridgeCursor}`);
    if (this.opts.cfg.bridgeEnabled !== false) {
      const client = new DshClient({
        url: () => this.url,
        name: () => this.opts.name?.() ?? 'Coopanion',
        onFrame: (frame) => void this.onFrame(frame),
        onState: (connected, session) => {
          this.connected = connected;
          this.session = session?.session ?? '';
          this.model = session?.model ?? '';
          if (connected) {
            host.log.info(`DSH bridge connected: session ${session?.session ?? ''}`);
            this.flushPending();
          }
        },
        log: (level, text) => {
          if (level === 'warn') host.log.warn(text);
          else host.log.info(text);
        },
      });
      this.client = client;
      client.start();
    }
    this.scanTimer = setInterval(() => void this.scan(), SCAN_MS);
    this.scanTimer.unref?.();
  }

  async stop(): Promise<void> {
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

  /** One line aside for when the bridge is back; the oldest drops once the queue is full. */
  private hold(text: string, cursor: number): void {
    if (this.handedOver.has(cursor) || this.pending.some((p) => p.cursor === cursor)) return;
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
      invoke: async (panel, method) => {
        if (panel !== 'dsh' || method !== 'state') throw new Error(`unknown ${panel}.${method}`);
        return this.state();
      },
    };
  }

  /** What the WebUI page shows; the protocol revision is part of it so a mismatch is visible. */
  state(): Record<string, unknown> {
    return {
      connected: this.connected,
      url: this.url,
      session: this.session,
      model: this.model,
      protocol: PROTOCOL_VERSION,
    };
  }
}

/** One panel, with the state method the WebUI polls. */
function panelDecls(): WorldPanelDecl[] {
  return [{ id: 'dsh', title: 'DSH', getMethods: ['state'] }];
}
