/**
 * The audio formats the Edge read-aloud API accepts, and the file extension each maps to.
 * Only the streaming formats the upstream package exposes are listed.
 *
 * Vendored from msedge-tts v2.1.0 (MIT), https://github.com/Migushthe2nd/MsEdgeTTS,
 * copyright (c) Migushthe2nd.
 */

export const OUTPUT_FORMAT = {
  AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3',
  AUDIO_24KHZ_96KBITRATE_MONO_MP3: 'audio-24khz-96kbitrate-mono-mp3',
  WEBM_24KHZ_16BIT_MONO_OPUS: 'webm-24khz-16bit-mono-opus',
} as const;

export type OutputFormat = (typeof OUTPUT_FORMAT)[keyof typeof OUTPUT_FORMAT];

export const OUTPUT_EXTENSIONS: Record<string, string> = {
  [OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3]: 'mp3',
  [OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3]: 'mp3',
  [OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS]: 'webm',
};
