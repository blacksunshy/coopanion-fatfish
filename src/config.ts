/**
 * The `worlds.fatfish` config section: the whole pack in one place — the DSH bridge on one side,
 * the Edge TTS voice on the other.
 *
 * The bridge keys keep the names the old `worlds.dsh` section used (minus `enabled`, which becomes
 * `bridgeEnabled` so the two on/off switches never collide); a deployment that carried the old
 * section over needs those four values copied, nothing else. The voice is any Edge TTS ShortName;
 * the config offers the short list as choices and accepts a hand-typed one.
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import { fatfishText } from './i18n/index.ts';
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

export interface FatfishConfigSection {
  [key: string]: unknown;
  /** The whole pack; the framework reads this one to decide whether the World mounts. */
  enabled: boolean;
  // ---- the DSH bridge half ----
  /** Bridges the pet to DeepSeek Harness. */
  bridgeEnabled: boolean;
  /** The Host half's WebSocket URL. */
  url: string;
  /** Relay the person's own lines to DSH, so the pet's other mouth hears them too. */
  relayPerson: boolean;
  /** Relay what the pet says and does to DSH. */
  relayPet: boolean;
  // ---- the voice half ----
  /** Reads the pet's replies aloud. */
  ttsEnabled: boolean;
  /**
   * A ready-made voice pack, or `custom` to use the four settings below. A pack is a voice plus
   * the pace, tone and loudness that suit it; picking one overrides those settings.
   */
  preset: string;
  /** The Edge TTS voice ShortName. */
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
  relayPerson: true,
  relayPet: false,
  ttsEnabled: true,
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
          [at('relayPerson')]: { type: 'boolean', title: t.relayPerson, description: t.relayPersonHint, 'x-hot': false },
          [at('relayPet')]: { type: 'boolean', title: t.relayPet, description: t.relayPetHint, 'x-hot': false },
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
