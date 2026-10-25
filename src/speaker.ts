/**
 * The mouth of the TTS World: one line of text in, one spoken clip out.
 *
 * Synthesis goes through the vendored Edge TTS client (src/vendor/msedge-tts), whose WebSocket
 * is reused across lines; playback hands the clip to a player child — winmm MCI via PowerShell
 * on Windows, the built-in `afplay` on macOS — whose `play … wait` blocks until the clip ends,
 * so the child's exit is the end of the speech. A new line kills the child still speaking, the
 * way Coo starting a new sentence cuts the previous one short.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from './vendor/msedge-tts/index.ts';

const MP3 = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

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

export class Speaker {
  private tts: MsEdgeTTS | null = null;
  private metadataKey = '';
  private player: ChildProcess | null = null;
  private stage: string | null = null;
  private failedAt = 0;
  private warnedPlatform = false;

  /** One line spoken aloud; resolves when playback ends or is cut. `false` means synthesis failed and the line was skipped. */
  async speak(text: string, opts: SpeakOptions, log: (line: string) => void): Promise<boolean> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      if (!this.warnedPlatform) {
        this.warnedPlatform = true;
        log(`TTS playback needs Windows or macOS; skipping on ${process.platform}`);
      }
      return false;
    }
    if (Date.now() - this.failedAt < COOLDOWN_MS) return false;

    const clip = await this.synthesise(text, opts, log);
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

  /** One mp3 out of one line; the WebSocket is kept across lines and re-inited only when the voice settings change. */
  private async synthesise(text: string, opts: SpeakOptions, log: (line: string) => void): Promise<string | null> {
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
      let child: ChildProcess;
      if (process.platform === 'darwin') {
        // afplay ships with macOS and, like MCI's `play … wait`, blocks until the clip ends.
        child = spawn('afplay', [clip], { stdio: 'ignore' });
      } else {
        const quoted = `"${clip}"`;
        const script = [
          "Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport(\"winmm.dll\", CharSet=CharSet.Auto)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr hwnd);'",
          `[WinMM.MCI]::mciSendString('open ${quoted} type mpegvideo alias tts', $null, 0, [System.IntPtr]::Zero) | Out-Null`,
          "[WinMM.MCI]::mciSendString('play tts wait', $null, 0, [System.IntPtr]::Zero) | Out-Null",
          "[WinMM.MCI]::mciSendString('close tts', $null, 0, [System.IntPtr]::Zero) | Out-Null",
        ].join('; ');
        child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
      }
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
