/**
 * The opt-in sentence pipeline: how a bubble is split, when it is not, and the order in which the
 * clips are prepared and played. The pipeline's whole point is that the next sentence must be
 * synthesising before the current one plays, so the tests assert that order directly.
 *
 * The speaker is replaced on the prototype, so no test touches the network or plays a sound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { FATFISH_DEFAULTS, PIPELINE_CHARS_RANGE, resolvePipeline } from '../src/config.ts';
import { MIN_SENTENCE_CHARS, Speaker, splitSentences, type PreparedClip } from '../src/speaker.ts';
import { FatfishWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const running: FatfishWorld[] = [];

afterEach(async () => {
  for (const world of running.splice(0)) await world.stop();
  vi.restoreAllMocks();
});

/** Waits until `check` holds, or fails the test. */
async function until(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('condition never held');
}

interface Recorder {
  /** Every speech step in the order it happened, e.g. `prepare(第一句。)`. */
  steps: string[];
  /** The texts handed to synthesis, in order. */
  prepared: string[];
  /** How many prepared clips were dropped without playing. */
  discarded: number;
}

/** A world whose speaker is replaced by recorders; returns the world and its event store. */
async function recordWorld(cfg: Record<string, unknown>): Promise<{ world: FatfishWorld; host: FakeHost; rec: Recorder }> {
  const rec: Recorder = { steps: [], prepared: [], discarded: 0 };
  let clips = 0;
  vi.spyOn(Speaker.prototype, 'prepare').mockImplementation(async (text: string) => {
    rec.steps.push(`prepare(${text})`);
    rec.prepared.push(text);
    return { clip: `/tmp/fatfish-pipeline-${++clips}.mp3` } as PreparedClip;
  });
  vi.spyOn(Speaker.prototype, 'playPrepared').mockImplementation(async (prepared: PreparedClip) => {
    rec.steps.push(`play(${prepared.clip})`);
    return true;
  });
  vi.spyOn(Speaker.prototype, 'discard').mockImplementation(async () => {
    rec.discarded++;
  });
  const host = new FakeHost();
  const world = new FatfishWorld({ cfg: { bridgeEnabled: false, discover: false, ...cfg } as never });
  running.push(world);
  await world.start(host as never);
  return { world, host, rec };
}

/** Pushes one of the pet's own lines through the scan loop and waits for the speech to finish. */
function feedLine(host: FakeHost, text: string): Promise<EventEnvelope> {
  return host.pushEvent({
    type: 'desktop-pet.self',
    source: 'desktop-pet',
    ts: new Date().toISOString(),
    text: '',
    meta: { kind: 'say', beats: [{ text }] },
  } as never);
}

/** One sentence with ten characters, so four of them make exactly the forty-char threshold. */
const TEN = '一二三四五六七八九。';

describe('splitSentences', () => {
  it('cuts at Chinese end punctuation and keeps it on the piece', () => {
    expect(splitSentences('今天天气不错。我们出去走走吧！')).toEqual(['今天天气不错。', '我们出去走走吧！']);
  });

  it('cuts at English ! ? ; but deliberately not at a plain .', () => {
    expect(splitSentences('Hello there, my friend! How are you today? Fine; good to hear.')).toEqual([
      'Hello there, my friend!',
      'How are you today?',
      'Fine; good to hear.',
    ]);
    // a plain period is also the decimal point and the abbreviation marker
    expect(splitSentences('Version 1.2 is out. It works.')).toEqual(['Version 1.2 is out. It works.']);
  });

  it('rides fragments shorter than the minimum with the piece next to them', () => {
    expect(splitSentences('嗯。好。今天天气真不错。')).toEqual(['嗯。好。今天天气真不错。']);
    expect(splitSentences('走。')).toEqual(['走。']);
    // a short piece joins the next one, and gluing English fragments keeps the space
    expect(splitSentences('Hi! Yes! Really?')).toEqual(['Hi! Yes!', 'Really?']);
    expect(splitSentences('First long enough! Ok!')).toEqual(['First long enough! Ok!']);
    for (const piece of splitSentences('今天天气不错。嗯。我们出去走走吧！')) {
      expect(piece.length).toBeGreaterThanOrEqual(MIN_SENTENCE_CHARS);
    }
  });

  it('treats a newline and an ellipsis as boundaries too', () => {
    expect(splitSentences('第一行意思不错\n第二行也不错')).toEqual(['第一行意思不错', '第二行也不错']);
    expect(splitSentences('等我想想……好吧，就这样。')).toEqual(['等我想想……', '好吧，就这样。']);
  });

  it('returns nothing for an empty line', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n ')).toEqual([]);
  });
});

describe('the pipeline settings', () => {
  it('are off unless switched on, and default to forty characters', () => {
    expect(resolvePipeline({})).toEqual({ enabled: false, maxChars: 40 });
    expect(resolvePipeline(FATFISH_DEFAULTS)).toEqual({ enabled: false, maxChars: 40 });
    expect(resolvePipeline({ sentencePipelineEnabled: true })).toEqual({ enabled: true, maxChars: 40 });
    expect(resolvePipeline({ sentencePipelineEnabled: 'true' as never }).enabled).toBe(false);
  });

  it('clamp a hand-edited threshold into the offered range', () => {
    expect(resolvePipeline({ sentencePipelineEnabled: true, sentencePipelineMaxChars: 2 }).maxChars).toBe(PIPELINE_CHARS_RANGE.min);
    expect(resolvePipeline({ sentencePipelineEnabled: true, sentencePipelineMaxChars: 9999 }).maxChars).toBe(PIPELINE_CHARS_RANGE.max);
    expect(resolvePipeline({ sentencePipelineEnabled: true, sentencePipelineMaxChars: 'abc' as never }).maxChars).toBe(40);
  });
});

describe('a line through the pipeline', () => {
  it('prepares the next sentence before the current one plays', async () => {
    const { host, rec } = await recordWorld({ sentencePipelineEnabled: true });
    await feedLine(host, '今天天气不错。我们出去走走吧！');
    await until(() => rec.steps.filter((step) => step.startsWith('play')).length === 2);

    const firstPlay = rec.steps.findIndex((step) => step.startsWith('play'));
    const secondPrepare = rec.steps.findIndex((step) => step === 'prepare(我们出去走走吧！)');
    expect(secondPrepare).toBeGreaterThan(-1);
    expect(secondPrepare).toBeLessThan(firstPlay);
    expect(rec.prepared).toEqual(['今天天气不错。', '我们出去走走吧！']);
    expect(rec.discarded).toBe(0);
  });

  it('splits a line of exactly maxChars and keeps a longer one whole', async () => {
    const atThreshold = await recordWorld({ sentencePipelineEnabled: true, sentencePipelineMaxChars: 40 });
    expect(TEN.repeat(4)).toHaveLength(40);
    await feedLine(atThreshold.host, TEN.repeat(4));
    await until(() => atThreshold.rec.steps.filter((step) => step.startsWith('play')).length === 4);
    expect(atThreshold.rec.prepared).toHaveLength(4);
    await atThreshold.world.stop();

    const overThreshold = await recordWorld({ sentencePipelineEnabled: true, sentencePipelineMaxChars: 40 });
    const long = `${TEN.repeat(4)}好`;
    expect(long).toHaveLength(41);
    await feedLine(overThreshold.host, long);
    await until(() => overThreshold.rec.steps.filter((step) => step.startsWith('play')).length === 1);
    expect(overThreshold.rec.prepared).toEqual([long]);
    await overThreshold.world.stop();
  });

  it('leaves a single-sentence line on the old whole-clip path', async () => {
    const { host, rec } = await recordWorld({ sentencePipelineEnabled: true });
    const speak = vi.spyOn(Speaker.prototype, 'speak').mockResolvedValue(true);
    await feedLine(host, '今天天气不错');
    await until(() => speak.mock.calls.length === 1);
    expect(speak.mock.calls[0][0]).toBe('今天天气不错');
    expect(rec.prepared).toHaveLength(0);
  });

  it('drops the rest of the line when a hush lands mid-pipeline', async () => {
    const { world, host, rec } = await recordWorld({ sentencePipelineEnabled: true });
    let hushed = false;
    vi.spyOn(Speaker.prototype, 'playPrepared').mockImplementation(async (prepared: PreparedClip) => {
      rec.steps.push(`play(${prepared.clip})`);
      if (!hushed) {
        hushed = true;
        const hush = world.tools().find((tool) => tool.name === 'tts_hush')!;
        await hush.handler({}, {} as never);
      }
      return true;
    });
    await feedLine(host, '第一句足够长。第二句也足够长。第三句同样够长。');
    await until(() => hushed);
    await until(() => rec.discarded >= 1);
    expect(rec.steps.filter((step) => step.startsWith('play'))).toHaveLength(1);
    await new Promise((done) => setTimeout(done, 200));
    expect(rec.steps.filter((step) => step.startsWith('play'))).toHaveLength(1);
    expect(rec.discarded).toBeGreaterThanOrEqual(1);
  });

  it('speaks exactly one clip per line when the pipeline is off', async () => {
    const { host } = await recordWorld({});
    const speak = vi.spyOn(Speaker.prototype, 'speak').mockResolvedValue(true);
    const prepare = vi.spyOn(Speaker.prototype, 'prepare');
    await feedLine(host, '今天天气不错。我们出去走走吧！');
    await until(() => speak.mock.calls.length === 1);
    expect(speak.mock.calls[0][0]).toBe('今天天气不错。我们出去走走吧！');
    expect(prepare).not.toHaveBeenCalled();
  });
});
