/**
 * SSML prosody knobs, with the vocabulary the speech service accepts for each.
 *
 * Vendored from msedge-tts v2.1.0 (MIT), https://github.com/Migushthe2nd/MsEdgeTTS,
 * copyright (c) Migushthe2nd.
 */

export interface ProsodyInput {
  /** `+0Hz`, a relative semitone (`+2st`), a percentage, or one of PITCH. */
  pitch?: string | number;
  /** A relative number (0.5), a percentage (`+50%`), or one of RATE. */
  rate?: string | number;
  /** 0-100, a relative value (`+50`), a percentage, or one of VOLUME. */
  volume?: string | number;
}

export const PROSODY_DEFAULTS: Required<ProsodyInput> = {
  pitch: '+0Hz',
  rate: 1.0,
  volume: 100.0,
};

export const RATE = {
  X_SLOW: 'x-slow',
  SLOW: 'slow',
  MEDIUM: 'medium',
  FAST: 'fast',
  X_FAST: 'x-fast',
  DEFAULT: 'default',
} as const;

export const PITCH = {
  X_LOW: 'x-low',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  X_HIGH: 'x-high',
  DEFAULT: 'default',
} as const;

export const VOLUME = {
  SILENT: 'silent',
  X_SOFT: 'x-soft',
  SOFT: 'soft',
  MEDIUM: 'medium',
  LOUD: 'loud',
  X_LOUD: 'x-LOUD',
  DEFAULT: 'default',
} as const;
