/** The World definition: what the assembly layer mounts, and what Core constructs. */
import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition, WorldContext, WorldDescribe } from 'cortico/world.ts';
import {
  FATFISH_DEFAULTS,
  FATFISH_ID,
  NOTIFY_OPTIONS_KIND,
  PRESET_OPTIONS_KIND,
  SEND_MAX,
  VOICE_OPTIONS_KIND,
  fatfishConfigGroups,
  notifyOptionRows,
  presetOptionRows,
  voiceOptionRows,
  type FatfishConfigSection,
} from './config.ts';
import { fatfishText } from './i18n/index.ts';
import { FatfishWorld } from './world.ts';

export interface FatfishAssembly {
  /** The app language, read at each use. */
  language?(): Language;
}

/**
 * The self-description the market reads instead of running the pack's code. The two tool texts
 * mirror what `tools()` produces under the default config (`relayPerson` on); `check:extension`
 * regenerates them under exactly that config and compares.
 */
const DESCRIBE: WorldDescribe = {
  tools: [
    {
      name: 'dsh_send',
      description:
        'Hand one line to the DeepSeek Harness conversation this pet is bridged to; DSH treats it as a message from the person. ' +
        "The person's own lines reach DSH through the bridge itself, and the notice that follows one says it arrived; hand over a line only when you have seen no such notice. " +
        "DSH writes the pet's name in a prefix of its own, so text that already carries one arrives inside a second. " +
        'The receipt says whether DSH accepted it. Do not call it to narrate what you are doing.',
      tags: ['speak'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: SEND_MAX, description: "What to hand over, in the person's own words where you have them." },
        },
        required: ['text'],
      },
      summary: { zh: '把一句话转交给桥接的 DSH（DeepSeek Harness）会话。', en: 'Hand one line over to the bridged DSH conversation.' },
    },
    {
      name: 'dsh_pick_session',
      description:
        'Point this pet at a different DeepSeek Harness session, by its id. ' +
        'By default the pet follows the newest open conversation; use this when the person wants your words to go into an older one ' +
        '(for example after archiving the current session). It only accepts a session that is still open on the DSH side; a closed or unknown id is refused.',
      tags: ['speak'],
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', maxLength: 128, description: 'The id of the DSH session to speak into.' },
        },
        required: ['session'],
      },
      summary: { zh: '把桌宠说话的对象切到另一个 DSH 会话（按 id）。', en: 'Switch the DSH session the pet speaks into, by id.' },
    },
    {
      name: 'dsh_new_session',
      description: [
        'Start a new DeepSeek Harness conversation and point this pet at it.',
        'Use it when the person asks for a new session, when DSH has no open conversation — for example after they archived them all, which makes dsh_send refuse with "no conversation is open on the DSH side" — or when the work belongs in a different project.',
        'Pass `workspace` with a path or an id from dsh_workspaces to put the conversation in that project; without it the Host uses the current conversation\'s workspace.',
        'The receipt names the new session and the workspace it landed in; words you hand over afterwards go there.',
      ].join(' '),
      tags: ['speak'],
      parameters: {
        type: 'object',
        properties: {
          workspace: {
            type: 'string',
            maxLength: 512,
            description: 'Path or id of the DSH workspace to start the conversation in. Omit to stay in the current one.',
          },
        },
      },
      summary: { zh: '在 DSH 侧新建一个会话（可指定工作区），并把桌宠接过去。', en: 'Start a new DSH conversation, optionally in a named workspace, and point this pet at it.' },
    },
    {
      name: 'dsh_workspaces',
      description: [
        'List the DeepSeek Harness projects (workspaces) this pet may start a conversation in.',
        'Each row carries a path, an id and how many conversations are open in it; pass either the path or the id as `workspace` to dsh_new_session.',
        'Ask for it before moving work to another project, so the name you pass is one DSH actually has.',
      ].join(' '),
      tags: ['speak'],
      parameters: { type: 'object', properties: {} },
      summary: { zh: '列出 DSH 的工作区（路径 / id / 打开的会话数）。', en: 'List the DSH workspaces a new conversation may target.' },
    },
    {
      name: 'tts_hush',
      description:
        'Stop the voice that reads your replies aloud, right now. ' +
        'Call it when the person asks for silence, asks you to skip the rest of what you were saying, or before a long stretch of quiet work. ' +
        'It stops the line being spoken and drops the lines still queued; nothing queued after it is spoken. ' +
        'It affects only the sound; the bubble text is untouched.',
      tags: ['speak'],
      parameters: { type: 'object', properties: {} },
      summary: { zh: '立即停止语音朗读，并清掉还在排队的句子。', en: 'Stop the read-aloud voice right away and drop the queued lines.' },
    },
  ],
  events: [
    {
      type: `${FATFISH_ID}.notice`,
      description: {
        zh: '桥接通知：人物的台词已转交 DSH、DSH 每轮结束时的结果与回复、等待批准或回答，以及出错。默认不逐个工具调用唤醒。',
        en: 'Bridge notices: a person\'s line handed to DSH, the result and reply of each finished DSH turn, pending approvals or questions, and errors. Tool calls no longer wake the bot one by one by default.',
      },
      trigger: 'flush',
    },
  ],
};

/** The definition, with what an embedding app lends the World. */
export function fatfishDefinition(assembly: FatfishAssembly = {}): WorldDefinition<FatfishConfigSection> {
  return {
    id: FATFISH_ID,
    get label() {
      return fatfishText(assembly.language?.()).label;
    },
    defaults: () => structuredClone(FATFISH_DEFAULTS),
    describe: DESCRIBE,
    // the voice and voice-pack dropdowns' rows come from here: the framework asks every mounted
    // World for its `x-options` kind, so the pack serves its own lists without app-side wiring
    configOptions: (kind: string, language: Language) => {
      if (kind === VOICE_OPTIONS_KIND) return voiceOptionRows();
      if (kind === PRESET_OPTIONS_KIND) return presetOptionRows(language);
      if (kind === NOTIFY_OPTIONS_KIND) return notifyOptionRows(language);
      return [];
    },
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
        stateDir: ctx.dataDir,
      }),
  };
}

/** The definition with no embedding app: Chinese. */
export const FATFISH = fatfishDefinition();

export { fatfishConfigGroups };
