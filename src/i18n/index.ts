/** Text of this World, in the app language: the bridge half, the voice half, and the pack around them. */
import type { Language } from 'cortico/core/language.ts';
import { en } from './en.ts';
import { zh } from './zh.ts';

export interface FatfishText {
  label: string;
  lamps: {
    // the bridge lamp
    bridge: string;
    connected: string;
    offline: string;
    // the voice lamp
    speech: string;
    speaking: string;
    idle: string;
    failed: string;
  };
  /** The WebUI panel: where the bridge listens and which conversation its notices belong to. */
  panel: {
    title: string;
    desc: string;
    url: string;
    session: string;
    model: string;
    protocol: string;
    /** "Bind current" button label. */
    bind: string;
    /** "Unbind" button label. */
    unbind: string;
    /** Chip label shown when pinned to a fixed session. */
    pinned: string;
    /** Row label shown when DSH default owner differs from the pinned one. */
    following: string;
    /** Bind button disabled because bridge is not connected. */
    notConnected: string;
    /** Bind succeeded, argument is session id. */
    bound: (session: string) => string;
    /** Bind failed prefix (error reason appended). */
    bindFailed: string;
    /** Unbind succeeded. */
    unbound: string;
    /** Unbind failed prefix. */
    unbindFailed: string;
  };
  config: {
    // the bridge group
    bridgeTitle: string;
    bridgeEnabled: string;
    bridgeEnabledHint: string;
    url: string;
    urlHint: string;
    relayPerson: string;
    relayPersonHint: string;
    relayPet: string;
    relayPetHint: string;
    // the voice group
    voiceTitle: string;
    ttsEnabled: string;
    ttsEnabledHint: string;
    preset: string;
    presetHint: string;
    /** The row that means "use the four settings below". */
    presetCustom: string;
    voice: string;
    voiceHint: string;
    rate: string;
    rateHint: string;
    pitch: string;
    pitchHint: string;
    volume: string;
    volumeHint: string;
    readOptions: string;
    readOptionsHint: string;
  };
  /** The `tts_hush` receipt. */
  hush: { stopped: string; nothing: string };
  /** What the bot reads; the tool receipts. */
  model: {
    notConnected: string;
    sent: string;
    sendFailed: string;
    statusConnected: string;
    statusOffline: string;
  };
}

const TABLE: Record<'zh' | 'en', FatfishText> = { zh, en };

/** The table for `language`; every other language reads English. */
export function fatfishText(language: Language = 'zh'): FatfishText {
  return language === 'zh' ? TABLE.zh : TABLE.en;
}
