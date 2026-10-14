/** The World definition: what the assembly layer mounts, and what Core constructs. */
import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition, WorldContext } from 'cortico/world.ts';
import { TTS_DEFAULTS, TTS_ID, ttsConfigGroups, type TtsConfigSection } from './config.ts';
import { ttsText } from './i18n/index.ts';
import { TtsWorld } from './world.ts';

export interface TtsAssembly {
  /** The app language, read at each use. */
  language?(): Language;
}

/** The definition, with what an embedding app lends the World. */
export function ttsDefinition(assembly: TtsAssembly = {}): WorldDefinition<TtsConfigSection> {
  return {
    id: TTS_ID,
    get label() {
      return ttsText(assembly.language?.()).label;
    },
    defaults: () => structuredClone(TTS_DEFAULTS),
    preflight: (ctx: WorldContext<TtsConfigSection>) => {
      if (typeof ctx.cfg.voice !== 'string' || !ctx.cfg.voice.trim()) {
        throw new Error(ttsText(assembly.language?.()).config.voice);
      }
    },
    create: (ctx) =>
      new TtsWorld({
        cfg: ctx.cfg,
        language: () => assembly.language?.() ?? 'zh',
      }),
  };
}

/** The definition with no embedding app: Chinese. */
export const TTS = ttsDefinition();

export { ttsConfigGroups };
