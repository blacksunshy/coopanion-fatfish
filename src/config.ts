/**
 * The `worlds.tts` config section: whether the pet speaks, and with which voice.
 *
 * The voice is any Edge TTS ShortName; the config offers the short list as choices and accepts a
 * hand-typed one. Rate and volume are relative percentages Edge TTS reads straight into its SSML.
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import { ttsText } from './i18n/index.ts';
import { DEFAULT_VOICE, RATE_OPTIONS, VOICE_OPTIONS, VOLUME_OPTIONS } from './voices.ts';

export const TTS_ID = 'tts';

/** The options kind the voice dropdown fetches its rows under. */
export const TTS_VOICE_OPTIONS = 'tts.voices';

/** The `{value,label}` rows the `/api/config/options/:kind` endpoint serves for the voice dropdown. */
export function ttsVoiceOptions(): Array<{ value: string; label: string }> {
  return VOICE_OPTIONS.map((v) => ({ value: v.id, label: v.label }));
}

/** Where synthesised clips are staged before the player picks them up. */
export const CLIP_DIR = 'tts-clips';

export interface TtsConfigSection {
  [key: string]: unknown;
  /** Reads the pet's replies aloud. */
  enabled: boolean;
  /** The Edge TTS voice ShortName. */
  voice: string;
  /** Relative speaking rate, e.g. `+15%`. */
  rate: string;
  /** Relative volume, e.g. `+20%`. */
  volume: string;
  /** Reads the choices of a question the pet asks, after the question itself. */
  readOptions: boolean;
}

export const TTS_DEFAULTS: TtsConfigSection = {
  enabled: true,
  voice: DEFAULT_VOICE,
  rate: '+0%',
  volume: '+0%',
  readOptions: true,
};

/** The console's config group for this World; keys are paths inside `worlds.tts`. */
export function ttsConfigGroups(language: Language = 'zh'): ConfigGroup[] {
  const t = ttsText(language).config;
  const at = (key: string): string => `worlds.${TTS_ID}.${key}`;
  return [
    {
      id: `world:${TTS_ID}`,
      owner: `world:${TTS_ID}`,
      schema: {
        type: 'object',
        title: t.title,
        properties: {
          [at('enabled')]: { type: 'boolean', title: t.enabled, description: t.enabledHint, 'x-hot': true },
          [at('voice')]: {
            type: 'string',
            title: t.voice,
            description: t.voiceHint,
            'x-options': TTS_VOICE_OPTIONS,
            'x-hot': true,
          },
          [at('rate')]: { type: 'string', title: t.rate, description: t.rateHint, enum: [...RATE_OPTIONS], 'x-hot': true },
          [at('volume')]: { type: 'string', title: t.volume, description: t.volumeHint, enum: [...VOLUME_OPTIONS], 'x-hot': true },
          [at('readOptions')]: { type: 'boolean', title: t.readOptions, description: t.readOptionsHint, 'x-hot': true },
        },
      },
    },
  ];
}
