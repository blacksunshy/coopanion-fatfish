/** The World definition: what the assembly layer mounts, and what Core constructs. */
import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition, WorldContext } from 'cortico/world.ts';
import { FATFISH_DEFAULTS, FATFISH_ID, fatfishConfigGroups, VOICE_OPTIONS_KIND, voiceOptionRows, type FatfishConfigSection } from './config.ts';
import { fatfishText } from './i18n/index.ts';
import { FatfishWorld } from './world.ts';

export interface FatfishAssembly {
  /** The app language, read at each use. */
  language?(): Language;
}

/** The definition, with what an embedding app lends the World. */
export function fatfishDefinition(assembly: FatfishAssembly = {}): WorldDefinition<FatfishConfigSection> {
  return {
    id: FATFISH_ID,
    get label() {
      return fatfishText(assembly.language?.()).label;
    },
    defaults: () => structuredClone(FATFISH_DEFAULTS),
    // the voice dropdown's rows come from here: the framework asks every mounted World for
    // its `x-options` kind, so the pack serves its own list without any app-side wiring
    configOptions: (kind: string) => (kind === VOICE_OPTIONS_KIND ? voiceOptionRows() : []),
    preflight: (ctx: WorldContext<FatfishConfigSection>) => {
      const t = fatfishText(assembly.language?.()).config;
      if (typeof ctx.cfg.voice !== 'string' || !ctx.cfg.voice.trim()) {
        throw new Error(t.voice);
      }
      if (typeof ctx.cfg.url !== 'string' || !/^wss?:\/\//.test(ctx.cfg.url.trim())) {
        throw new Error(t.url);
      }
    },
    create: (ctx) =>
      new FatfishWorld({
        cfg: ctx.cfg,
        language: () => assembly.language?.() ?? 'zh',
      }),
  };
}

/** The definition with no embedding app: Chinese. */
export const FATFISH = fatfishDefinition();

export { fatfishConfigGroups };
