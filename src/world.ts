/**
 * The TTS World: speaks what the pet says.
 *
 * The pet's lines are `desktop-pet.self` events, stored and never delivered to the bot; this World
 * scans the store the way the DSH bridge does, picks up `say` and `ask` records, and reads them
 * aloud with the voice the person picked. It has no words of its own: the speech is the bubble's
 * echo, and the only tool it offers is one that stops it.
 */
import type { EventEnvelope, ToolDef, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { speakable } from './clean.ts';
import { ttsConfigGroups, type TtsConfigSection } from './config.ts';
import { ttsText, type TtsText } from './i18n/index.ts';
import { Speaker, type SpeakOptions } from './speaker.ts';

/** The pet's own lines; the pet World owns the type, this World only reads it. */
const SELF_TYPE = 'desktop-pet.self';
/** The scan cadence; it reads the in-process event store, not the disk. */
const SCAN_MS = 1500;

export interface TtsWorldOptions {
  /** The live `worlds.tts` section. */
  cfg: TtsConfigSection;
  /** The app language, read at each use. */
  language?(): string;
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

export class TtsWorld implements World {
  readonly id = 'tts';
  private host: WorldHost | null = null;
  private lastSeenCursor = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly speaker = new Speaker();
  /** Serialises speech: one clip at a time, the next starting as this one ends. */
  private chain: Promise<void> = Promise.resolve();
  private speaking = false;
  private failed = false;

  constructor(private readonly opts: TtsWorldOptions) {}

  private get t(): TtsText {
    return ttsText((this.opts.language?.() as 'zh' | 'en') ?? 'zh');
  }

  private get voice(): SpeakOptions {
    const cfg = this.opts.cfg;
    const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
    return {
      voice: str(cfg.voice, 'zh-CN-XiaoxiaoNeural'),
      rate: str(cfg.rate, '+0%'),
      volume: str(cfg.volume, '+0%'),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // only what happens while this World is up is spoken; a restart does not replay the old lines
    this.lastSeenCursor = host.store.latestCursor();
    host.log.info(`tts armed, voice=${this.voice.voice}, fromCursor=${this.lastSeenCursor}`);
    this.scanTimer = setInterval(() => void this.scan(), SCAN_MS);
    this.scanTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    await this.speaker.stop();
    this.host = null;
  }

  /** One scan of the pet's self events; a line is picked up once, at its own cursor. */
  private async scan(): Promise<void> {
    const host = this.host;
    if (!host || this.opts.cfg.enabled === false) return;
    let events: EventEnvelope[];
    try {
      events = host.store.range({ fromCursor: this.lastSeenCursor + 1, limit: 50 });
    } catch {
      return;
    }
    for (const event of events) {
      this.lastSeenCursor = Math.max(this.lastSeenCursor, event.cursor);
      if (event.type !== SELF_TYPE) continue;
      const line = lineOf(event, this.opts.cfg.readOptions !== false);
      if (line) {
        host.log.info(`tts speaking: ${line.slice(0, 60)}`);
        this.enqueue(line);
      }
    }
  }

  /** Hands one line to the speech chain; returns at once, the line speaks when its turn comes. */
  private enqueue(line: string): void {
    this.chain = this.chain
      .then(() => this.say(line))
      .catch(() => {});
  }

  private async say(line: string): Promise<void> {
    const host = this.host;
    if (!host || this.opts.cfg.enabled === false) return;
    this.speaking = true;
    try {
      const spoken = await this.speaker.speak(line, this.voice, (text) => host.log.info(text));
      host.log.info(spoken ? 'tts played' : 'tts skipped (cooldown/off-platform)');
      this.failed = !spoken;
    } finally {
      this.speaking = false;
    }
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'tts_hush',
        description: [
          'Stop the voice that reads your replies aloud, right now.',
          'Call it when the person asks for silence, asks you to skip the rest of what you were saying, or before a long stretch of quiet work.',
          'It affects only the sound; the bubble text is untouched.',
        ].join(' '),
        tags: ['speak'],
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const wasSpeaking = this.speaking;
          this.speaker.hush();
          return wasSpeaking ? this.t.hush.stopped : this.t.hush.nothing;
        },
      },
    ];
  }

  envPromptVars(): Record<string, string> {
    const on = this.opts.cfg.enabled !== false;
    return {
      'tts.status': !on
        ? 'off'
        : this.failed
          ? 'error'
          : this.speaking
            ? 'speaking'
            : 'ready',
    };
  }

  console(language: string = 'zh'): WorldConsoleDecl {
    const t = ttsText((language as 'zh' | 'en') ?? 'zh');
    return {
      label: t.label,
      lamps: [
        {
          label: t.lamps.speech,
          state: this.opts.cfg.enabled === false ? 'offline' : this.failed ? 'error' : this.speaking ? 'loading' : 'online',
          hint: this.opts.cfg.enabled === false ? t.lamps.idle : this.failed ? t.lamps.failed : this.speaking ? t.lamps.speaking : t.lamps.idle,
        },
      ],
      panels: [],
      config: ttsConfigGroups((language as 'zh' | 'en') ?? 'zh'),
    };
  }
}
