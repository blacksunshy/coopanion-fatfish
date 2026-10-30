/**
 * The mouth of the TTS World: one line of text in, one spoken clip out.
 *
 * Synthesis goes through the vendored Edge TTS client (src/vendor/msedge-tts), whose WebSocket
 * is reused across lines; playback hands the clip to a player child — winmm MCI via PowerShell
 * on Windows, the built-in `afplay` on macOS — whose `play … wait` blocks until the clip ends,
 * so the child's exit is the end of the speech. A new line kills the child still speaking, the
 * way Coo starting a new sentence cuts the previous one short.
 *
 * `engine: 'http'` replaces only the synthesis step: the configured URL is asked for audio and
 * the bytes stage in the same temp directory, so playback, interruption and hush are unchanged.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from './vendor/msedge-tts/index.ts';

const MP3 = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/** The engine settings one line is spoken with; the World resolves them from the config. */
export interface TtsEngineConfig {
  /** `edge` (the built-in service, the default) or `http` (a server of the person's own). */
  engine: 'edge' | 'http';
  /** Where the http engine POSTs; empty means it is not configured, which counts as a failure. */
  httpUrl: string;
  /** The `speed` field the http engine sends; `1` is the server's normal pace. */
  speed: number;
  /** How long one http attempt may take before it counts as failed. */
  timeoutMs: number;
  /** Fall back to Edge when the http engine fails, instead of leaving the line unspoken. */
  fallbackEdge: boolean;
}

/** What an install that never touched the new keys speaks with: exactly the old behaviour. */
export const DEFAULT_ENGINE: TtsEngineConfig = {
  engine: 'edge',
  httpUrl: '',
  speed: 1,
  timeoutMs: 20_000,
  fallbackEdge: true,
};

/** A clip shorter than this cannot be speech worth playing; a server that says less is broken. */
const MIN_AUDIO_BYTES = 1000;

export interface SpeakOptions {
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
}

/** After a failed synthesis the next attempts inside this window are skipped, so a rate limit or a dropped link does not spam the log. */
const COOLDOWN_MS = 10_000;
/** How many times one line is tried: a dropped link is worth one fresh connection before the line is skipped. */
const ATTEMPTS = 2;
/** The pause before that retry, long enough for a half-open socket to be gone. */
const RETRY_DELAY_MS = 400;

/**
 * One clip out of an http engine: POST `{ input, voice, speed }` and take the audio bytes back.
 * Node's own fetch does the request and `timeoutMs` caps the whole attempt. The reply's content
 * type — or its RIFF header, when the server is vague — names the temp file's extension, because
 * the Windows player has to open a matching MCI device.
 */
export async function synthesiseHttp(
  text: string,
  cfg: Pick<TtsEngineConfig, 'httpUrl' | 'speed' | 'timeoutMs'>,
  voice: string,
  stage: string,
): Promise<string> {
  const url = typeof cfg.httpUrl === 'string' ? cfg.httpUrl.trim() : '';
  if (!url) throw new Error('http engine is selected but httpUrl is empty');
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_ENGINE.timeoutMs;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: text, voice, speed: Number.isFinite(cfg.speed) ? cfg.speed : 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // fetch reports the deadline as a TimeoutError DOMException; older runtimes wrap it.
    const name = (err as Error)?.name;
    const cause = (err as { cause?: Error })?.cause;
    if (name === 'TimeoutError' || cause?.name === 'TimeoutError') {
      throw new Error(`http tts timed out after ${timeoutMs} ms`);
    }
    throw err;
  }
  if (!response.ok) throw new Error(`http tts answered HTTP ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < MIN_AUDIO_BYTES) {
    throw new Error(`http tts returned ${audio.length} bytes, too short to be speech`);
  }
  const file = join(stage, `http-${randomUUID()}${clipExtension(response.headers.get('content-type'), audio)}`);
  await writeFile(file, audio);
  return file;
}

/** The extension a clip earns: the content type wins, then the RIFF header, then mp3 by default. */
export function clipExtension(contentType: string | null, audio: Buffer): '.wav' | '.mp3' {
  const type = contentType ?? '';
  if (/wav/i.test(type)) return '.wav';
  if (/mpeg|mp3/i.test(type)) return '.mp3';
  if (audio.length >= 4 && audio.toString('latin1', 0, 4) === 'RIFF') return '.wav';
  return '.mp3';
}

/**
 * The player child one clip is spoken with: `afplay` on macOS, winmm MCI through PowerShell on
 * Windows. An http engine may answer wav or mp3, and the MCI device has to match: `mpegvideo` on
 * a wave file plays nothing, `waveaudio` on an mp3 does the same. afplay sniffs the format itself.
 */
export function playCommand(clip: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'afplay', args: [clip] };
  }
  const quoted = `"${clip}"`;
  const device = /\.wav$/i.test(clip) ? 'waveaudio' : 'mpegvideo';
  const script = [
    "Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport(\"winmm.dll\", CharSet=CharSet.Auto)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr hwnd);'",
    `[WinMM.MCI]::mciSendString('open ${quoted} type ${device} alias tts', $null, 0, [System.IntPtr]::Zero) | Out-Null`,
    "[WinMM.MCI]::mciSendString('play tts wait', $null, 0, [System.IntPtr]::Zero) | Out-Null",
    "[WinMM.MCI]::mciSendString('close tts', $null, 0, [System.IntPtr]::Zero) | Out-Null",
  ].join('; ');
  return { command: 'powershell', args: ['-NoProfile', '-Command', script] };
}

export class Speaker {
  private tts: MsEdgeTTS | null = null;
  private metadataKey = '';
  private player: ChildProcess | null = null;
  private stage: string | null = null;
  private failedAt = 0;
  private warnedPlatform = false;

  /** One line spoken aloud; resolves when playback ends or is cut. `false` means synthesis failed and the line was skipped. */
  async speak(text: string, opts: SpeakOptions, log: (line: string) => void, engine: TtsEngineConfig = DEFAULT_ENGINE): Promise<boolean> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      if (!this.warnedPlatform) {
        this.warnedPlatform = true;
        log(`TTS playback needs Windows or macOS; skipping on ${process.platform}`);
      }
      return false;
    }
    if (Date.now() - this.failedAt < COOLDOWN_MS) return false;

    const clip = await this.synthesise(text, opts, log, engine);
    if (!clip) return false;
    await this.play(clip, log);
    await rm(clip, { force: true });
    return true;
  }

  /** Stops the clip in play, if any. */
  hush(): void {
    this.player?.kill();
    this.player = null;
  }

  async stop(): Promise<void> {
    this.hush();
    this.release();
    if (this.stage) {
      await rm(this.stage, { recursive: true, force: true }).catch(() => {});
      this.stage = null;
    }
  }

  /** Drops the TTS client; the next line dials a fresh socket instead of reusing a broken one. */
  private release(): void {
    this.tts?.close();
    this.tts = null;
    this.metadataKey = '';
  }

  /** One clip out of one line, from whichever engine the config names. `null` means the line is skipped. */
  private async synthesise(
    text: string,
    opts: SpeakOptions,
    log: (line: string) => void,
    engine: TtsEngineConfig,
  ): Promise<string | null> {
    if (engine.engine === 'http') {
      try {
        this.stage ??= await mkdtemp(join(tmpdir(), 'coopanion-tts-'));
        const clip = await synthesiseHttp(text, engine, opts.voice, this.stage);
        log(`TTS http engine: ${text.length} chars -> ${clip}`);
        return clip;
      } catch (err) {
        const reason = (err as Error).message;
        if (engine.fallbackEdge === false) {
          this.failedAt = Date.now();
          log(`TTS http engine failed: ${reason} (fallbackEdge is off, line skipped)`);
          return null;
        }
        log(`TTS http engine failed: ${reason} (falling back to Edge)`);
      }
    }
    return this.synthesiseEdge(text, opts, log);
  }

  /** One mp3 out of one line; the WebSocket is kept across lines and re-inited only when the voice settings change. */
  private async synthesiseEdge(text: string, opts: SpeakOptions, log: (line: string) => void): Promise<string | null> {
    const key = [opts.voice, opts.rate, opts.volume, opts.pitch].join('|');
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        this.tts ??= new MsEdgeTTS({ enableLogger: false });
        if (key !== this.metadataKey) {
          await this.tts.setMetadata(opts.voice, MP3);
          this.metadataKey = key;
        }
        this.stage ??= await mkdtemp(join(tmpdir(), 'coopanion-tts-'));
        const { audioFilePath } = await this.tts.toFile(this.stage, text, {
          rate: opts.rate,
          volume: opts.volume,
          pitch: opts.pitch,
        });
        return audioFilePath;
      } catch (err) {
        // A connection that timed out or dropped is not reused: the retry gets a new socket, so a
        // lost first connection costs one more try instead of silence until the World restarts.
        this.release();
        if (attempt === ATTEMPTS) {
          this.failedAt = Date.now();
          log(`TTS synthesis failed: ${(err as Error).message}`);
          return null;
        }
        await new Promise((done) => setTimeout(done, RETRY_DELAY_MS));
      }
    }
    return null;
  }

  /** Plays one clip; the player child's exit is the end of the speech, and killing it is the interruption. */
  private play(clip: string, log: (line: string) => void): Promise<void> {
    this.hush();
    return new Promise((resolve) => {
      const { command, args } = playCommand(clip);
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
      this.player = child;
      child.once('exit', () => {
        if (this.player === child) this.player = null;
        resolve();
      });
      child.once('error', (err) => {
        log(`TTS playback failed: ${err.message}`);
        if (this.player === child) this.player = null;
        resolve();
      });
    });
  }
}

/** The directory synthesised clips stage in; created on demand. */
export async function ensureStage(): Promise<string> {
  const dir = join(tmpdir(), 'coopanion-tts');
  await mkdir(dir, { recursive: true });
  return dir;
}
