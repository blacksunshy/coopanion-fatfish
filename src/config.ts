/**
 * The `worlds.fatfish` config section: the whole pack in one place — the DSH bridge on one side,
 * the Edge TTS voice on the other.
 *
 * The bridge keys keep the names the old `worlds.dsh` section used (minus `enabled`, which becomes
 * `bridgeEnabled` so the two on/off switches never collide); a deployment that carried the old
 * section over needs those four values copied, nothing else. The voice is any Edge TTS ShortName;
 * the config offers the short list as choices and accepts a hand-typed one.
 *
 * The voice half also names the engine behind it (`edge`, the built-in service and the default, or
 * `http`, a server of the person's own) and, optionally, a sentence pipeline. Both are add-only
 * and off unless switched on: an install that never touched them speaks exactly as before.
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import { fatfishText } from './i18n/index.ts';
import type { TtsEngineConfig } from './speaker.ts';
import {
  CUSTOM_PRESET,
  DEFAULT_VOICE,
  PITCH_OPTIONS,
  RATE_OPTIONS,
  VOICE_OPTIONS,
  VOICE_PRESETS,
  VOLUME_OPTIONS,
} from './voices.ts';

export const FATFISH_ID = 'fatfish';

/** The options kind the voice dropdown fetches its rows under; the app side serves the rows. */
export const VOICE_OPTIONS_KIND = 'fatfish.voices';

/** The options kind the voice-pack dropdown fetches its rows under. */
export const PRESET_OPTIONS_KIND = 'fatfish.presets';

/** The options kind the bridge-notice dropdown fetches its rows under. */
export const NOTIFY_OPTIONS_KIND = 'fatfish.notify';

/** The options kind the engine dropdown fetches its rows under. */
export const ENGINE_OPTIONS_KIND = 'fatfish.engines';

/** How much of DSH's progress is handed to the bot. */
export type NotifyMode =
  /** Only what DSH produced and what waits on the person: one line per finished turn, plus approvals, questions and errors. */
  | 'results'
  /** Every frame, one wake per event — the behaviour before this setting existed. */
  | 'all'
  /** Nothing: the pet still talks to DSH, but DSH never wakes it. */
  | 'off';

/** Which synthesis engine speaks the pet's lines; `edge` is the default and the old behaviour. */
export type VoiceEngine = 'edge' | 'http';

/** The dropdown rows for `NOTIFY_OPTIONS_KIND`, in the order the config shows them. */
export function notifyOptionRows(language?: Language): Array<{ value: NotifyMode; label: string }> {
  const t = fatfishText(language).config;
  return [
    { value: 'results', label: t.notifyResults },
    { value: 'all', label: t.notifyAll },
    { value: 'off', label: t.notifyOff },
  ];
}

/** The dropdown rows for `ENGINE_OPTIONS_KIND`, in the order the config shows them. */
export function engineOptionRows(language?: Language): Array<{ value: VoiceEngine; label: string }> {
  const t = fatfishText(language).config;
  return [
    { value: 'edge', label: t.engineEdge },
    { value: 'http', label: t.engineHttp },
  ];
}

/** The `{value,label}` rows the `/api/config/options/:kind` endpoint serves for the voice dropdown. */
export function voiceOptionRows(): Array<{ value: string; label: string }> {
  return VOICE_OPTIONS.map((v) => ({ value: v.id, label: v.label }));
}

/** The `{value,label}` rows for the voice-pack dropdown; `custom` first, then the packs. */
export function presetOptionRows(language?: Language): Array<{ value: string; label: string }> {
  return [
    { value: CUSTOM_PRESET, label: fatfishText(language).config.presetCustom },
    ...VOICE_PRESETS.map((preset) => ({
      value: preset.id,
      label: language === 'en' ? preset.labelEn : preset.label,
    })),
  ];
}

/** Where the bridge looks for the Host half; the Host prints this in its console. */
export const DEFAULT_URL = 'ws://127.0.0.1:19387/coopanion/pet';

/** Longest text the pet sends into one DSH turn. */
export const SEND_MAX = 4000;

/** How many characters of one DSH reply the pet is told; the rest is in the DSH console. */
export const RELAY_MAX = 1200;

/** The bounds the engine settings accept; a hand-edited config outside them is clamped, not obeyed. */
export const SPEED_RANGE = { min: 0.25, max: 4 } as const;
export const TIMEOUT_RANGE = { min: 1_000, max: 120_000 } as const;

/** The bounds of the pipeline's whole-text threshold. */
export const PIPELINE_CHARS_RANGE = { min: 8, max: 200 } as const;

/** The pipeline settings as the World consumes them. */
export interface SentencePipelineConfig {
  /** Off by default: the old single-clip behaviour, unchanged. */
  enabled: boolean;
  /** A line longer than this is synthesised whole instead of split; `40` by default. */
  maxChars: number;
}

export interface FatfishConfigSection {
  [key: string]: unknown;
  /** The whole pack; the framework reads this one to decide whether the World mounts. */
  enabled: boolean;
  // ---- the DSH bridge half ----
  /** Bridges the pet to DeepSeek Harness. */
  bridgeEnabled: boolean;
  /** The Host half's WebSocket URL. */
  url: string;
  /**
   * Auto-find the Host on loopback when the configured URL does not answer. Off it means the
   * configured URL (or the remembered port) is the only thing tried — for VPN clients whose
   * filter driver treats the discovery sweep's loopback connects as an attack.
   */
  discover: boolean;
  /** Relay the person's own lines to DSH, so the pet's other mouth hears them too. */
  relayPerson: boolean;
  /** Relay what the pet says and does to DSH. */
  relayPet: boolean;
  /**
   * How much DSH progress wakes the bot. `results` keeps one notice per finished turn plus the
   * events that need the person; `all` is one wake per frame; `off` never wakes the bot.
   */
  notify: NotifyMode;
  // ---- the voice half ----
  /** Reads the pet's replies aloud. */
  ttsEnabled: boolean;
  /** Which engine synthesises the speech: `edge` (default) or `http` (a server of the person's own). */
  engine: VoiceEngine;
  /** Where the http engine POSTs `{ input, voice, speed }`; empty means it is not configured. */
  httpUrl: string;
  /** The `speed` field the http engine sends; `1` is the server's normal pace. */
  speed: number;
  /** Fall back to Edge when the http engine fails or times out, instead of skipping the line. */
  fallbackEdge: boolean;
  /** How long one http attempt may take, in milliseconds, before it counts as failed. */
  timeoutMs: number;
  /**
   * Splits a short line at sentence punctuation and synthesises the next sentence while the
   * current one plays. Off by default; on, a line above `sentencePipelineMaxChars` stays whole.
   */
  sentencePipelineEnabled: boolean;
  /** The whole-text threshold: a line longer than this is one clip, not a split line. */
  sentencePipelineMaxChars: number;
  /**
   * A ready-made voice pack, or `custom` to use the four settings below. A pack is a voice plus
   * the pace, tone and loudness that suit it; picking one overrides those settings.
   */
  preset: string;
  /** The Edge TTS voice ShortName; with the http engine it is the `voice` field of the request. */
  voice: string;
  /** Relative speaking rate, e.g. `+15%`. */
  rate: string;
  /** Relative pitch, e.g. `-2Hz`. */
  pitch: string;
  /** Relative volume, e.g. `+20%`. */
  volume: string;
  /** Reads the choices of a question the pet asks, after the question itself. */
  readOptions: boolean;
}

export const FATFISH_DEFAULTS: FatfishConfigSection = {
  enabled: true,
  bridgeEnabled: true,
  url: DEFAULT_URL,
  discover: true,
  relayPerson: false,
  relayPet: false,
  notify: 'results',
  ttsEnabled: true,
  engine: 'edge',
  httpUrl: '',
  speed: 1,
  fallbackEdge: true,
  timeoutMs: 20_000,
  sentencePipelineEnabled: false,
  sentencePipelineMaxChars: 40,
  preset: CUSTOM_PRESET,
  voice: DEFAULT_VOICE,
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
  readOptions: true,
};

/** What the Speaker needs for one line: either a preset's settings or the four custom ones. */
export interface SpeakSettings {
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
}

/**
 * Turns the voice half of the config into the speaker settings. A known preset wins over the
 * individual fields, so a pack stays consistent as a whole; `custom` (or an unknown id left over
 * from an older config) falls back to them.
 */
export function resolveSpeak(cfg: Partial<FatfishConfigSection>): SpeakSettings {
  const preset = VOICE_PRESETS.find((candidate) => candidate.id === cfg.preset);
  if (preset) {
    return { voice: preset.voice, rate: preset.rate, volume: preset.volume, pitch: preset.pitch };
  }
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return {
    voice: str(cfg.voice, DEFAULT_VOICE),
    rate: str(cfg.rate, '+0%'),
    volume: str(cfg.volume, '+0%'),
    pitch: str(cfg.pitch, '+0Hz'),
  };
}

/** A finite number from a possibly hand-edited config, clamped, or the fallback. */
function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Turns the engine keys into what the Speaker consumes. Missing or nonsensical values all fall
 * back to the Edge defaults: a config written before these keys existed keeps the old behaviour,
 * and the http engine cannot take over by accident.
 */
export function resolveEngine(cfg: Partial<FatfishConfigSection>): TtsEngineConfig {
  return {
    engine: cfg.engine === 'http' ? 'http' : 'edge',
    httpUrl: typeof cfg.httpUrl === 'string' ? cfg.httpUrl.trim() : '',
    speed: numberIn(cfg.speed, 1, SPEED_RANGE.min, SPEED_RANGE.max),
    timeoutMs: Math.round(numberIn(cfg.timeoutMs, 20_000, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max)),
    fallbackEdge: cfg.fallbackEdge !== false,
  };
}

/**
 * Turns the pipeline keys into what the World consumes. It is off unless explicitly switched on,
 * so an old config and a fresh install speak exactly as they did before. `maxChars` is only read
 * when the pipeline is on, and a missing or nonsensical value falls back to 40.
 */
export function resolvePipeline(cfg: Partial<FatfishConfigSection>): SentencePipelineConfig {
  return {
    enabled: cfg.sentencePipelineEnabled === true,
    maxChars: Math.round(numberIn(cfg.sentencePipelineMaxChars, 40, PIPELINE_CHARS_RANGE.min, PIPELINE_CHARS_RANGE.max)),
  };
}

/** The WebUI's config groups for this World; keys are paths inside `worlds.fatfish`. */
export function fatfishConfigGroups(language: Language = 'zh'): ConfigGroup[] {
  const t = fatfishText(language).config;
  const at = (key: string): string => `worlds.${FATFISH_ID}.${key}`;
  return [
    {
      id: `world:${FATFISH_ID}.bridge`,
      owner: `world:${FATFISH_ID}`,
      schema: {
        type: 'object',
        title: t.bridgeTitle,
        properties: {
          [at('bridgeEnabled')]: { type: 'boolean', title: t.bridgeEnabled, description: t.bridgeEnabledHint, 'x-hot': false },
          [at('url')]: { type: 'string', title: t.url, description: t.urlHint, 'x-hot': false },
          [at('discover')]: { type: 'boolean', title: t.discover, description: t.discoverHint, 'x-hot': false },
          [at('relayPerson')]: { type: 'boolean', title: t.relayPerson, description: t.relayPersonHint, 'x-hot': false },
          [at('relayPet')]: { type: 'boolean', title: t.relayPet, description: t.relayPetHint, 'x-hot': false },
          [at('notify')]: { type: 'string', title: t.notify, description: t.notifyHint, 'x-options': NOTIFY_OPTIONS_KIND, 'x-hot': true },
        },
      },
    },
    {
      id: `world:${FATFISH_ID}.voice`,
      owner: `world:${FATFISH_ID}`,
      schema: {
        type: 'object',
        title: t.voiceTitle,
        properties: {
          [at('ttsEnabled')]: { type: 'boolean', title: t.ttsEnabled, description: t.ttsEnabledHint, 'x-hot': true },
          [at('engine')]: {
            type: 'string',
            title: t.engine,
            description: t.engineHint,
            'x-options': ENGINE_OPTIONS_KIND,
            'x-hot': true,
          },
          [at('httpUrl')]: { type: 'string', title: t.httpUrl, description: t.httpUrlHint, 'x-hot': true },
          [at('speed')]: {
            type: 'number',
            title: t.speed,
            description: t.speedHint,
            minimum: SPEED_RANGE.min,
            maximum: SPEED_RANGE.max,
            'x-hot': true,
          },
          [at('fallbackEdge')]: { type: 'boolean', title: t.fallbackEdge, description: t.fallbackEdgeHint, 'x-hot': true },
          [at('timeoutMs')]: {
            type: 'number',
            title: t.timeoutMs,
            description: t.timeoutMsHint,
            minimum: TIMEOUT_RANGE.min,
            maximum: TIMEOUT_RANGE.max,
            'x-hot': true,
          },
          [at('sentencePipelineEnabled')]: {
            type: 'boolean',
            title: t.sentencePipeline,
            description: t.sentencePipelineHint,
            'x-hot': true,
          },
          [at('sentencePipelineMaxChars')]: {
            type: 'number',
            title: t.sentencePipelineMaxChars,
            description: t.sentencePipelineMaxCharsHint,
            minimum: PIPELINE_CHARS_RANGE.min,
            maximum: PIPELINE_CHARS_RANGE.max,
            'x-hot': true,
          },
          [at('preset')]: {
            type: 'string',
            title: t.preset,
            description: t.presetHint,
            'x-options': PRESET_OPTIONS_KIND,
            'x-hot': true,
          },
          [at('voice')]: {
            type: 'string',
            title: t.voice,
            description: t.voiceHint,
            'x-options': VOICE_OPTIONS_KIND,
            'x-hot': true,
          },
          [at('rate')]: { type: 'string', title: t.rate, description: t.rateHint, enum: [...RATE_OPTIONS], 'x-hot': true },
          [at('pitch')]: { type: 'string', title: t.pitch, description: t.pitchHint, enum: [...PITCH_OPTIONS], 'x-hot': true },
          [at('volume')]: { type: 'string', title: t.volume, description: t.volumeHint, enum: [...VOLUME_OPTIONS], 'x-hot': true },
          [at('readOptions')]: { type: 'boolean', title: t.readOptions, description: t.readOptionsHint, 'x-hot': true },
        },
      },
    },
  ];
}
