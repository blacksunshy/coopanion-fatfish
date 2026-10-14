/** Turns a chat line into something worth reading aloud: markup and emoji out, length capped. */

/** Emoji and symbol runs read as nothing; the SSML template chokes on them anyway. */
const NOISE = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
/** Markdown emphasis and code marks. */
const MARKS = /[*_`~#>|]+/g;
/** A URL reads as nothing; the words around it carry the meaning. */
const URLS = /https?:\/\/\S+/g;
/** Runs of whitespace and lone separators. */
const SPACES = /\s{2,}/g;

/** The most one spoken clip may carry; the rest is on screen. */
export const SPEAK_MAX = 600;

/**
 * One clip's text out of one chat line. Returns an empty string when nothing speakable remains
 * (an image-only beat, a table dump), so the caller skips the clip instead of speaking silence.
 */
export function speakable(text: string): string {
  const cleaned = text
    .replace(URLS, ' ')
    .replace(NOISE, ' ')
    .replace(MARKS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > SPEAK_MAX ? `${cleaned.slice(0, SPEAK_MAX)}……` : cleaned;
}
