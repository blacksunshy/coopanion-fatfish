/**
 * The synthesis engine the config picks: what the http engine sends and stages, how a failure
 * falls back to Edge (or does not), and how long one http attempt may take.
 *
 * Nothing here plays a clip: every test stops at the synthesised file (or replaces the playback
 * step), so the suite needs no speaker, no network and no sound.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FATFISH_DEFAULTS, resolveEngine, SPEED_RANGE, TIMEOUT_RANGE } from '../src/config.ts';
import {
  DEFAULT_ENGINE,
  Speaker,
  clipExtension,
  playCommand,
  synthesiseHttp,
  type SpeakOptions,
  type TtsEngineConfig,
} from '../src/speaker.ts';

const OPTIONS: SpeakOptions = { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' };

interface FakeEngine {
  /** The URL to hand to the engine config. */
  url: string;
  /** Every request body, in arrival order. */
  bodies: string[];
  close(): Promise<void>;
}

const engines: FakeEngine[] = [];
const stages: string[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const stage of stages.splice(0)) await rm(stage, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A temp directory for one test's staged clips. */
async function newStage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-http-test-'));
  stages.push(dir);
  return dir;
}

/** A loopback HTTP server a test answers from; the request body is recorded for assertions. */
async function fakeEngine(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<FakeEngine> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      handler(req, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  const engine: FakeEngine = {
    url: `http://127.0.0.1:${port}/tts`,
    bodies,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
  engines.push(engine);
  return engine;
}

/** Bytes that look enough like a wav for the engine to stage them. */
function wavBytes(size = 2048): Buffer {
  const audio = Buffer.alloc(size);
  audio.write('RIFF', 0, 'latin1');
  return audio;
}

/** Bytes standing in for an mp3 (no magic number is checked). */
function mp3Bytes(size = 2048): Buffer {
  return Buffer.alloc(size, 7);
}

/** A speaker whose private Edge/playback steps are replaced, so speaking touches nothing real. */
function stubbedSpeaker(edgeClip = '/tmp/fatfish-test-edge.mp3'): {
  speaker: Speaker;
  edge: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
} {
  const speaker = new Speaker();
  const edge = vi.fn(async () => edgeClip);
  const play = vi.fn(async () => undefined);
  Object.assign(speaker as unknown as Record<string, unknown>, { synthesiseEdge: edge, play });
  return { speaker, edge, play };
}

describe('the engine settings', () => {
  it('default to Edge, exactly as before the keys existed', () => {
    expect(resolveEngine({})).toEqual(DEFAULT_ENGINE);
    expect(DEFAULT_ENGINE).toMatchObject({ engine: 'edge', fallbackEdge: true, speed: 1, timeoutMs: 20_000, httpUrl: '' });
    // a config written before the keys existed resolves the same way
    expect(resolveEngine(FATFISH_DEFAULTS)).toEqual(DEFAULT_ENGINE);
    expect(FATFISH_DEFAULTS.engine).toBe('edge');
  });

  it('take http only when it is named, and clamp hand-edited numbers', () => {
    expect(resolveEngine({ engine: 'http', httpUrl: ' http://127.0.0.1:9880/tts ' })).toMatchObject({
      engine: 'http',
      httpUrl: 'http://127.0.0.1:9880/tts',
    });
    expect(resolveEngine({ engine: 'nonsense' as never }).engine).toBe('edge');
    expect(resolveEngine({ speed: 99 }).speed).toBe(SPEED_RANGE.max);
    expect(resolveEngine({ speed: 0 }).speed).toBe(SPEED_RANGE.min);
    expect(resolveEngine({ timeoutMs: 5 }).timeoutMs).toBe(TIMEOUT_RANGE.min);
    expect(resolveEngine({ timeoutMs: 'abc' as never }).timeoutMs).toBe(20_000);
    expect(resolveEngine({ fallbackEdge: false }).fallbackEdge).toBe(false);
  });
});

describe('the http engine', () => {
  it('posts the agreed body and stages the reply as a clip', async () => {
    const engine = await fakeEngine((_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wavBytes());
    });
    const stage = await newStage();
    const clip = await synthesiseHttp('你好，世界', { httpUrl: engine.url, speed: 1.25, timeoutMs: 2_000 }, 'voice-x', stage);

    expect(JSON.parse(engine.bodies[0])).toEqual({ input: '你好，世界', voice: 'voice-x', speed: 1.25 });
    expect(clip.endsWith('.wav')).toBe(true);
    expect(await readFile(clip)).toEqual(wavBytes());
  });

  it('name an mp3 reply from its content type, and a vague wav reply from its header', async () => {
    const mp3 = await fakeEngine((_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(mp3Bytes());
    });
    const riff = await fakeEngine((_req, res) => {
      res.writeHead(200);
      res.end(wavBytes());
    });
    const stage = await newStage();
    expect((await synthesiseHttp('a', { httpUrl: mp3.url, speed: 1, timeoutMs: 2_000 }, 'v', stage)).endsWith('.mp3')).toBe(true);
    expect((await synthesiseHttp('b', { httpUrl: riff.url, speed: 1, timeoutMs: 2_000 }, 'v', stage)).endsWith('.wav')).toBe(true);
  });

  it('rejects a non-200 answer and a reply too short to be speech', async () => {
    const broken = await fakeEngine((_req, res) => {
      res.writeHead(503);
      res.end('nope');
    });
    const tiny = await fakeEngine((_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(mp3Bytes(16));
    });
    const stage = await newStage();
    await expect(synthesiseHttp('a', { httpUrl: broken.url, speed: 1, timeoutMs: 2_000 }, 'v', stage))
      .rejects.toThrow(/HTTP 503/);
    await expect(synthesiseHttp('a', { httpUrl: tiny.url, speed: 1, timeoutMs: 2_000 }, 'v', stage))
      .rejects.toThrow(/too short/);
  });

  it('rejects an empty address instead of guessing one', async () => {
    const stage = await newStage();
    await expect(synthesiseHttp('a', { httpUrl: '', speed: 1, timeoutMs: 2_000 }, 'v', stage))
      .rejects.toThrow(/httpUrl is empty/);
  });

  it('gives up at timeoutMs when the server never answers', async () => {
    const hanging = await fakeEngine(() => {
      // intentionally never answers; the client deadline is the only way out
    });
    const stage = await newStage();
    const started = Date.now();
    await expect(synthesiseHttp('a', { httpUrl: hanging.url, speed: 1, timeoutMs: 150 }, 'v', stage))
      .rejects.toThrow(/timed out after 150 ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('falling back to Edge', () => {
  it('speaks the line through Edge when the http engine fails, without asking', async () => {
    const broken = await fakeEngine((_req, res) => {
      res.writeHead(500);
      res.end('down');
    });
    const { speaker, edge, play } = stubbedSpeaker();
    const logs: string[] = [];
    const spoken = await speaker.speak('你好', OPTIONS, (line) => logs.push(line), {
      ...DEFAULT_ENGINE,
      engine: 'http',
      httpUrl: broken.url,
      timeoutMs: 2_000,
    });

    expect(spoken).toBe(true);
    expect(edge).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('falling back to Edge');
    await speaker.stop();
  });

  it('skips the line (and stays quiet for a moment) when fallbackEdge is off', async () => {
    const broken = await fakeEngine((_req, res) => {
      res.writeHead(500);
      res.end('down');
    });
    const { speaker, edge } = stubbedSpeaker();
    const logs: string[] = [];
    const spoken = await speaker.speak('你好', OPTIONS, (line) => logs.push(line), {
      ...DEFAULT_ENGINE,
      engine: 'http',
      httpUrl: broken.url,
      timeoutMs: 2_000,
      fallbackEdge: false,
    });

    expect(spoken).toBe(false);
    expect(edge).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('fallbackEdge is off');
    await speaker.stop();
  });

  it('never touches the network when the engine is Edge', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { speaker, edge } = stubbedSpeaker();
    const spoken = await speaker.speak('你好', OPTIONS, () => {}, DEFAULT_ENGINE);
    expect(spoken).toBe(true);
    expect(edge).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    await speaker.stop();
  });
});

describe('the player command', () => {
  it('uses afplay on macOS and an MCI device that matches the clip', () => {
    expect(playCommand('/tmp/a.mp3', 'darwin')).toEqual({ command: 'afplay', args: ['/tmp/a.mp3'] });
    const wave = playCommand('/tmp/a.wav', 'win32');
    expect(wave.command).toBe('powershell');
    expect(wave.args.join(' ')).toContain('type waveaudio alias tts');
    const mp3 = playCommand('/tmp/a.mp3', 'win32');
    expect(mp3.args.join(' ')).toContain('type mpegvideo alias tts');
  });
});

describe('naming a clip', () => {
  it('prefers the content type, then the RIFF header, and falls back to mp3', () => {
    expect(clipExtension('audio/wav', mp3Bytes())).toBe('.wav');
    expect(clipExtension(null, wavBytes())).toBe('.wav');
    expect(clipExtension('audio/mpeg', wavBytes())).toBe('.mp3');
    expect(clipExtension(null, mp3Bytes())).toBe('.mp3');
    expect(clipExtension('application/octet-stream', mp3Bytes())).toBe('.mp3');
  });
});

// The config type is what `world.ts` resolves from; a smoke test keeps the exported shape honest.
const engineConfig: TtsEngineConfig = DEFAULT_ENGINE;
describe('the resolved engine config', () => {
  it('is the shape the speaker accepts', () => {
    expect(Object.keys(engineConfig).sort()).toEqual(['engine', 'fallbackEdge', 'httpUrl', 'speed', 'timeoutMs'].sort());
  });
});
