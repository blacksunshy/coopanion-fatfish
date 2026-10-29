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
    /** "Pin to current session" button label. */
    bind: string;
    /** "Unpin" button label. */
    unbind: string;
    /** "Refresh test" button label — force-read bridge state to verify session/model refreshed. */
    testRefresh: string;
    /** Chip label shown when pinned to a fixed session. */
    pinned: string;
    /** Row label shown when DSH default owner differs from the pinned one. */
    following: string;
    /** Shown when the bridge is down (bind disabled; picker shows it on failure). */
    notConnected: string;
    /** Bind succeeded, argument is session id. */
    bound: (session: string) => string;
    /** Bind failed prefix (error reason appended). */
    bindFailed: string;
    /** Unbind succeeded. */
    unbound: string;
    /** Unbind failed prefix. */
    unbindFailed: string;
    /** Test refresh succeeded — shows current session/model, optionally with diff flags. */
    testResult: (session: string, model: string, sessionChanged?: boolean, modelChanged?: boolean) => string;
    /** Test refresh failed (bridge not reachable). */
    testFailed: string;
    /** "New session" button label — starts a DSH conversation when none is open. */
    newSession: string;
    /** New session succeeded, argument is the session id. */
    created: (session: string) => string;
    /** New session failed prefix (error reason appended). */
    createFailed: string;
    /** "Pick a session" toggle button label — opens the list of live DSH sessions. */
    pickSession: string;
    /** Label of the same button while the list is open. */
    pickHide: string;
    /** Shown inside the picker when DSH reports no live session. */
    noSessions: string;
    /** Shown inside the picker when the Host never answered the list request. */
    listFailed: string;
    /** Marker on the row the pet currently speaks into. */
    current: string;
    /** Marker on the row that is DSH's default owner. */
    owner: string;
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
    notify: string;
    notifyHint: string;
    /** The `results` row: one notice per finished turn plus what needs the person. */
    notifyResults: string;
    /** The `all` row: one wake per frame. */
    notifyAll: string;
    /** The `off` row: DSH never wakes the bot. */
    notifyOff: string;
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
    /** `dsh_new_session` succeeded; `{session}` is the conversation the Host made. */
    newSessionDone: string;
    /** `dsh_new_session` failed; `{reason}` is DSH's own wording. */
    newSessionFailed: string;
  };
}

const TABLE: Record<'zh' | 'en', FatfishText> = { zh, en };

/** The table for `language`; every other language reads English. */
export function fatfishText(language: Language = 'zh'): FatfishText {
  return language === 'zh' ? TABLE.zh : TABLE.en;
}
