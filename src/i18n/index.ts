/** Text of this World, in the app language. */
import type { Language } from 'cortico/core/language.ts';
import { en } from './en.ts';
import { zh } from './zh.ts';

export interface TtsText {
  label: string;
  lamps: { speech: string; speaking: string; idle: string; failed: string };
  config: {
    title: string;
    enabled: string;
    enabledHint: string;
    voice: string;
    voiceHint: string;
    rate: string;
    rateHint: string;
    volume: string;
    volumeHint: string;
    readOptions: string;
    readOptionsHint: string;
  };
  /** The `tts_hush` receipt. */
  hush: { stopped: string; nothing: string };
}

const TABLE: Record<'zh' | 'en', TtsText> = { zh, en };

/** The table for `language`; every other language reads English. */
export function ttsText(language: Language = 'zh'): TtsText {
  return language === 'zh' ? TABLE.zh : TABLE.en;
}
