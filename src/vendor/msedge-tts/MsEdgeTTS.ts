/**
 * The Edge read-aloud WebSocket client: setMetadata picks the voice, toFile synthesises one
 * line into an mp3, and the socket is reused across lines.
 *
 * Vendored from msedge-tts v2.1.0 (MIT), https://github.com/Migushthe2nd/MsEdgeTTS,
 * copyright (c) Migushthe2nd. Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the rights to use,
 * copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
 * subject to the following conditions: the above copyright notice and this permission notice
 * shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS
 * PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Ported for Node-only use: `isomorphic-ws` became `ws`, and the axios voices list plus the
 * browser `buffer` polyfill are dropped (this pack never calls getVoices). The reason this
 * code is vendored instead of depended on: upstream ships `preinstall: npx only-allow pnpm`,
 * which pnpm 11 treats as an unapproved build script and fails installs over.
 */
import { createWriteStream, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import WebSocket, { type ClientOptions } from 'ws';
import { OUTPUT_EXTENSIONS, type OutputFormat } from './Output.ts';
import { PROSODY_DEFAULTS, type ProsodyInput } from './Prosody.ts';

/** Synthesis settings; the locale is inferred from the voice ShortName unless given. */
export class MetadataOptions {
  voiceLocale?: string;
  sentenceBoundaryEnabled = false;
  wordBoundaryEnabled = false;
}

/** Construction options, mirroring the upstream `Options`. */
export interface MsEdgeTTSOptions {
  /** An http(s) agent for the WebSocket connection, e.g. a proxy. */
  agent?: ClientOptions['agent'];
  /** Log protocol chatter to the console. */
  enableLogger?: boolean;
  /** Milliseconds until connecting is declared a failure; 0 disables. Default 10000. */
  connectionTimeoutMs?: number;
  /** Milliseconds without synthesis activity until the stream errors; 0 disables. Default 60000. */
  synthesisTimeoutMs?: number;
}

const messageTypes = {
  TURN_START: 'turn.start',
  TURN_END: 'turn.end',
  RESPONSE: 'response',
  SPEECH_CONFIG: 'speech.config',
  AUDIO_METADATA: 'audio.metadata',
  AUDIO: 'audio',
  SSML: 'ssml',
} as const;

interface SynthesisStream {
  audio: Readable;
  metadata: Readable | null;
  turnEnded: boolean;
  socket?: WebSocket;
  timeout?: NodeJS.Timeout;
}

// ---- Sec-MS-GEC v2 ----
// Microsoft upgraded the read-aloud auth scheme around 2026-10: v1 (single SHA256 over
// "<ticks><token>") is rejected — the old endpoint answers plain 403, and
// api.msedgeservices.com answers a plain HTTP 200 instead of the 101 WebSocket upgrade.
// v2 token = "<CS64 16hex>-<SHA256 64hex>" and requires Sec-MS-GEC-Version "2-".
// Ported from readest PR #6751 (a TS port of rany2/edge-tts PR #492), which ships an
// official test vector; the vector is verified in tests/msedge-tts.test.ts.
const WIN_EPOCH_OFFSET = 11644473600;
const S_TO_NS = 1000000000;

// "Copyright (C) Microsoft Corporation. All rights reserved." (57 bytes) as little-endian u32 words.
const GEC_PREFIX_WORDS = [
  0x79706f43, 0x68676972, 0x43282074, 0x694d2029, 0x736f7263, 0x2074666f,
  0x70726f43, 0x7461726f, 0x2e6e6f69, 0x6c6c4120, 0x67697220, 0x20737468,
  0x65736572, 0x64657672, 0x0000002e,
];
const GEC_PREFIX_LENGTH = 57;

const rol16 = (x: number) => ((x << 16) | (x >>> 16)) >>> 0;

// little-endian 32-bit words, zero-padded up to an 8-byte boundary
const toWords = (bytes: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(bytes.length / 8) * 8);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  return Array.from({ length: padded.length / 4 }, (_, i) => view.getUint32(i * 4, true));
};

// CS64 first pass: word swap chain
const cs64WordSwap = (words: number[], a: number, b: number) => {
  let acc = 0;
  let last = 0;
  for (let i = 0; i < words.length; i += 2) {
    const x = words[i]!;
    const y = words[i + 1]!;
    let t = rol16((Math.imul(rol16(x), 0xef0569fb) + Math.imul(x, a)) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    acc = (acc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((Math.imul(rol16(y), 0xc31713db) + Math.imul(y, b)) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    last = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    acc = (acc + last) >>> 0;
  }
  return [last, acc];
};

// CS64 second pass: reversible state chain
const cs64Reversible = (words: number[], a: number, b: number) => {
  let state = 0;
  let acc = 0;
  for (let i = 0; i < words.length; i += 2) {
    state = Math.imul(state + words[i]!, a) >>> 0;
    for (const c of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = Math.imul(rol16(state), c) >>> 0;
    }
    let t = Math.imul(words[i + 1]! + state, b) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = rol16(Math.imul(rol16(t), 0xd38396ff) >>> 0);
    acc = (acc + state) >>> 0;
    state = Math.imul(rol16(Math.imul(t, 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [state, acc];
};

export class MsEdgeTTS {
  static readonly TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  static readonly WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
  private static readonly JSON_XML_DELIM = '\r\n\r\n';
  private static readonly AUDIO_DELIM = 'Path:audio\r\n';
  private static readonly VOICE_LANG_REGEX = /\b[a-z]{2,}-[A-Z]{2}\b/;
  private static _clockOffsetMs = 0;

  private readonly _enableLogger: boolean;
  private readonly _connectionTimeoutMs: number;
  private readonly _synthesisTimeoutMs: number;
  private readonly _agent: ClientOptions['agent'];
  private _ws?: WebSocket;
  private _clientInit?: Promise<void>;
  private _clientGeneration = 0;
  private _voice = '';
  private _outputFormat = '';
  private readonly _metadataOptions = new MetadataOptions();
  private readonly _streams: Record<string, SynthesisStream> = {};
  private _retiredSockets: WebSocket[] = [];
  private _startTime = 0;

  constructor(options?: MsEdgeTTSOptions) {
    this._agent = options?.agent ?? undefined;
    this._enableLogger = options?.enableLogger ?? false;
    this._connectionTimeoutMs = options?.connectionTimeoutMs === undefined ? 10_000 : options.connectionTimeoutMs;
    this._synthesisTimeoutMs = options?.synthesisTimeoutMs === undefined ? 60_000 : options.synthesisTimeoutMs;
    for (const [name, value] of Object.entries({ connectionTimeoutMs: this._connectionTimeoutMs, synthesisTimeoutMs: this._synthesisTimeoutMs })) {
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
        throw new Error(`${name} must be an integer between 0 and 2147483647 milliseconds.`);
      }
    }
  }

  private _log(...o: unknown[]): void {
    if (this._enableLogger) {
      console.log(...o);
    }
  }

  /** The URL a client connects to; the clock-derived Sec-MS-GEC is part of the query. */
  static async getSynthUrl(): Promise<string> {
    // Edge sends a 32-hex ConnectionId (no dashes), matching the reference clients
    const reqId = MsEdgeTTS.randomHex(16);
    const secMsGec = await MsEdgeTTS.generateSecMsGec(MsEdgeTTS.TRUSTED_CLIENT_TOKEN);
    return `${MsEdgeTTS.WSS_URL}?Ocp-Apim-Subscription-Key=${MsEdgeTTS.TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=2-143.0.3650.75&ConnectionId=${reqId}`;
  }

  // Random 32-hex muid cookie; Edge's read-aloud endpoint rejects bare handshakes (plain
  // HTTP 200 instead of the 101 upgrade) unless the request carries the same headers the
  // browser sends — Cookie: muid, Accept-*, Cache-Control (mirrors readest edgeTTS.ts).
  private static generateMuid(): string {
    return MsEdgeTTS.randomHex(16).toUpperCase();
  }

  private _initClient(): Promise<void> {
    if (this._clientInit) return this._clientInit;
    const init = this._createClient();
    const tracked = init.finally(() => {
      if (this._clientInit === tracked) this._clientInit = undefined;
    });
    this._clientInit = tracked;
    return tracked;
  }

  private async _createClient(
    retryClock = true,
    deadline = this._connectionTimeoutMs ? Date.now() + this._connectionTimeoutMs : 0,
    generation = this._clientGeneration,
  ): Promise<void> {
    const previous = this._ws;
    if (previous) {
      if (previous.readyState === previous.OPEN
        && Object.values(this._streams).some((stream) => stream.socket === previous && !stream.turnEnded)) {
        if (!this._retiredSockets.includes(previous)) this._retiredSockets.push(previous);
      }
      else {
        this._closeSocket(previous);
      }
    }

    const synthUrl = await MsEdgeTTS.getSynthUrl();
    if (generation !== this._clientGeneration) throw new Error('Edge TTS connection closed before initialization completed.');
    const remaining = deadline ? deadline - Date.now() : 0;
    if (deadline && remaining <= 0) throw new Error(`Edge TTS connection timed out after ${this._connectionTimeoutMs} milliseconds.`);

    const ws = this._ws = new WebSocket(synthUrl, {
      headers: {
        // Full Edge client header set. Akamai rejects bare handshakes with a plain HTTP 200,
        // and Electron's Node is pickier than CLI Node (subset that passes in CLI still gets
        // 200 in the desktop host) — verified in coopanion-fatfish issue #2.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Sec-CH-UA': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'websocket',
        'Sec-Fetch-Site': 'none',
        'Cookie': `muid=${MsEdgeTTS.generateMuid()};`,
      },
      agent: this._agent,
    });
    ws.binaryType = 'arraybuffer';

    return new Promise<void>((resolve, reject) => {
      let connecting = true;
      const connectionTimeout = this._connectionTimeoutMs ? setTimeout(() => {
        connecting = false;
        reject(new Error(`Edge TTS connection timed out after ${this._connectionTimeoutMs} milliseconds.`));
        this._closeSocket(ws);
      }, remaining) : undefined;

      ws.once('unexpected-response', (request, response) => {
        if (!connecting || ws.readyState !== ws.CONNECTING || generation !== this._clientGeneration) {
          request.destroy();
          response.destroy();
          return;
        }
        const error = Object.assign(new Error(`Unexpected server response: ${response.statusCode}`), {
          statusCode: response.statusCode,
          serverDate: response.headers.date,
        });
        // this listener suppresses ws's default handshake abort, so close both HTTP objects
        request.destroy(error);
        response.destroy();
      });

      ws.onopen = () => {
        if (!connecting) return;
        connecting = false;
        clearTimeout(connectionTimeout);
        this._log('Connected in', (Date.now() - this._startTime) / 1000, 'seconds');
        this._send(`Content-Type:application/json; charset=utf-8\r\nPath:${messageTypes.SPEECH_CONFIG}${MsEdgeTTS.JSON_XML_DELIM}
            {
                "context": {
                    "synthesis": {
                        "audio": {
                            "metadataoptions": {
                                "sentenceBoundaryEnabled": "${this._metadataOptions.sentenceBoundaryEnabled}",
                                "wordBoundaryEnabled": "${this._metadataOptions.wordBoundaryEnabled}"
                            },
                            "outputFormat": "${this._outputFormat}"
                        }
                    }
                }
            }`, undefined, ws).then(resolve, (error: Error) => {
          this._closeSocket(ws);
          reject(error);
        });
      };

      ws.onmessage = (m) => {
        const buffer = Buffer.from(m.data as ArrayBuffer);
        const message = buffer.toString();
        const requestId = /X-RequestId:(.*?)\r\n/.exec(message)?.[1];
        const stream = requestId && this._streams[requestId];
        if (!stream || stream.audio.destroyed || stream.turnEnded || stream.socket !== ws) return;
        if (message.includes(`Path:${messageTypes.TURN_START}`)) {
          // start of turn, ignore
          this._log('->', message);
          this._resetSynthesisTimeout(requestId);
        }
        else if (message.includes(`Path:${messageTypes.TURN_END}`)) {
          // end of turn, close stream
          this._log('->', message);
          clearTimeout(stream.timeout);
          stream.timeout = undefined;
          stream.turnEnded = true;
          stream.audio.push(null);
          this._closeRetiredSockets();
        }
        else if (message.includes(`Path:${messageTypes.RESPONSE}`)) {
          // context response, ignore
          this._log('->', message);
          this._resetSynthesisTimeout(requestId);
        }
        else if (message.includes(`Path:${messageTypes.AUDIO_METADATA}`)) {
          // audio metadata, wordboundary/sentenceboundary
          const dataStartIndex = buffer.indexOf(MsEdgeTTS.JSON_XML_DELIM) + MsEdgeTTS.JSON_XML_DELIM.length;
          const data = buffer.subarray(dataStartIndex);
          this._log('->', message);
          this._resetSynthesisTimeout(requestId);
          this._pushMetadata(data, requestId);
        }
        else if (message.includes(`Path:${messageTypes.AUDIO}`) && m.data instanceof ArrayBuffer) {
          const dataStartIndex = buffer.indexOf(MsEdgeTTS.AUDIO_DELIM) + MsEdgeTTS.AUDIO_DELIM.length;
          const headers = buffer.subarray(0, dataStartIndex).toString();
          const data = buffer.subarray(dataStartIndex);
          this._log('->', headers);
          this._resetSynthesisTimeout(requestId);
          this._pushAudioData(data, requestId);
        }
        else {
          this._log('->', 'UNKNOWN MESSAGE', message);
        }
      };

      ws.onclose = () => {
        connecting = false;
        clearTimeout(connectionTimeout);
        reject(new Error('Edge TTS connection closed before initialization completed.'));
        this._log('disconnected after:', (Date.now() - this._startTime) / 1000, 'seconds');
        for (const stream of Object.values(this._streams)) {
          if (stream.socket !== ws) continue;
          clearTimeout(stream.timeout);
          if (stream.turnEnded) {
            // synthesis finished normally, just close the stream
            stream.audio.push(null);
          }
          else {
            // socket closed before turn.end: the audio is truncated, so surface it as an
            // error instead of silently ending the stream as if it were complete
            stream.audio.destroy(new Error('Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.'));
          }
        }
      };

      ws.onerror = (event) => {
        connecting = false;
        clearTimeout(connectionTimeout);
        const underlying = event.error;
        const message = underlying?.message ?? String(underlying);
        const code = (underlying as NodeJS.ErrnoException | undefined)?.code;
        const wrapped = new Error(`Edge TTS WebSocket error: ${message}${code ? ` (code=${code})` : ''}`);
        wrapped.cause = underlying;
        reject(wrapped);
        for (const stream of Object.values(this._streams)) {
          if (stream.socket === ws && !stream.turnEnded) stream.audio.destroy(wrapped);
        }
        this._closeSocket(ws);
      };
    }).catch((error: unknown) => {
      const underlying = (error as { cause?: { statusCode?: number; serverDate?: string } | undefined })?.cause;
      const serverTime = typeof underlying?.serverDate === 'string' ? Date.parse(underlying.serverDate) : NaN;
      if (retryClock && underlying?.statusCode === 403 && Number.isFinite(serverTime)
        && generation === this._clientGeneration && (!deadline || Date.now() < deadline)) {
        MsEdgeTTS._clockOffsetMs = serverTime - Date.now();
        return this._createClient(false, deadline, generation);
      }
      throw error;
    });
  }

  private _closeSocket(socket: WebSocket): void {
    if (socket.readyState === socket.CLOSED) return;
    const terminate = socket.terminate;
    if (socket.readyState !== socket.OPEN && terminate) terminate.call(socket);
    else socket.close();
  }

  private _closeRetiredSockets(): void {
    // scans active streams on drain; per-socket counters if this becomes hot at high concurrency
    this._retiredSockets = this._retiredSockets.filter((socket) => {
      if (Object.values(this._streams).some((stream) => stream.socket === socket && !stream.turnEnded)) {
        return true;
      }
      socket.close();
      return false;
    });
  }

  static generateUUID(): string {
    return 'xxxxxxxx-xxxx-xxxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Sec-MS-GEC v2 token: "<CS64 16hex>-<SHA256 64hex>" over the copyright prefix plus
   * "<ticks><token>". `now` is injectable so the official test vector can pin the clock.
   */
  static async generateSecMsGec(trustedClientToken: string, now = Date.now() + MsEdgeTTS._clockOffsetMs): Promise<string> {
    let ticks = Math.floor(now / 1000);
    ticks += WIN_EPOCH_OFFSET;
    ticks -= ticks % 300; // 5-minute window
    ticks *= S_TO_NS / 100; // 100ns units

    const suffix = new TextEncoder().encode(`${ticks.toFixed(0)}${trustedClientToken}`);
    const data = new Uint8Array(GEC_PREFIX_LENGTH + suffix.length);
    const view = new DataView(data.buffer);
    GEC_PREFIX_WORDS.forEach((word, i) => view.setUint32(i * 4, word, true));
    data.set(suffix, GEC_PREFIX_LENGTH);

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const words = toWords(data);
    const [key0, key1] = toWords(digest);
    const a = (key0! | 1) >>> 0;
    const b = (key1! | 1) >>> 0;

    const [s0, s1] = cs64WordSwap(words, a, b);
    const [r0, r1] = cs64Reversible(words, a, b);
    const cs64 = new DataView(new ArrayBuffer(8));
    cs64.setUint32(0, s0! ^ r0!, true);
    cs64.setUint32(4, s1! ^ r1!, true);

    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${toHex(new Uint8Array(cs64.buffer))}-${toHex(digest)}`;
  }

  private async _send(message: string, requestId?: string, initialSocket?: WebSocket): Promise<void> {
    let socket = initialSocket ?? this._ws;
    for (let i = 1; !initialSocket && i <= 3 && socket && socket.readyState !== socket.OPEN; i++) {
      if (requestId && !this._streams[requestId]) return;
      if (i === 1) {
        this._startTime = Date.now();
      }
      this._log('connecting: ', i);
      await this._initClient();
      socket = this._ws;
    }
    if (requestId) {
      const stream = this._streams[requestId];
      if (!stream || stream.audio.destroyed || stream.turnEnded) return;
      stream.socket = socket;
    }
    const current = socket;
    if (!current || current.readyState !== current.OPEN) throw new Error('Edge TTS WebSocket is not open.');
    if (requestId) this._resetSynthesisTimeout(requestId);
    await new Promise<void>((resolve, reject) => {
      current.send(message, (error) => {
        if (error) return reject(error);
        this._log('<-', message);
        resolve();
      });
    });
  }

  private _resetSynthesisTimeout(requestId: string): void {
    const stream = this._streams[requestId];
    if (!stream || stream.audio.destroyed || stream.turnEnded) return;
    clearTimeout(stream.timeout);
    if (this._synthesisTimeoutMs) {
      stream.timeout = setTimeout(() => {
        stream.audio.destroy(new Error(`Edge TTS synthesis timed out after ${this._synthesisTimeoutMs} milliseconds without activity.`));
      }, this._synthesisTimeoutMs);
    }
  }

  private _pushAudioData(data: Buffer, requestId: string): void {
    this._streams[requestId]?.audio.push(data);
  }

  private _pushMetadata(data: Buffer, requestId: string): void {
    this._streams[requestId]?.metadata?.push(data);
  }

  private _SSMLTemplate(input: string, options: ProsodyInput = {}): string {
    // in case future updates to the edge API block these elements, we'll be concatenating strings.
    const o = { ...PROSODY_DEFAULTS, ...options };
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${this._metadataOptions.voiceLocale}">
                <voice name="${this._voice}">
                    <prosody pitch="${o.pitch}" rate="${o.rate}" volume="${o.volume}">
                        ${input}
                    </prosody>
                </voice>
            </speak>`;
  }

  /**
   * Sets the required information for the speech to be synthesised and inits a new WebSocket
   * connection. Must be called at least once before text can be synthesised. Merges the given
   * values into the previously provided ones.
   */
  async setMetadata(voiceName: string, outputFormat: OutputFormat, metadataOptions?: Partial<MetadataOptions>): Promise<void> {
    const oldVoice = this._voice;
    const oldOutputFormat = this._outputFormat;
    const oldOptions = JSON.stringify(this._metadataOptions);
    this._voice = voiceName;
    Object.assign(this._metadataOptions, metadataOptions);
    if (!metadataOptions?.voiceLocale && (!this._metadataOptions.voiceLocale || oldVoice !== this._voice)) {
      const voiceLangMatch = MsEdgeTTS.VOICE_LANG_REGEX.exec(this._voice);
      if (!voiceLangMatch) throw new Error('Could not infer voiceLocale from voiceName, and no voiceLocale was specified!');
      this._metadataOptions.voiceLocale = voiceLangMatch[0];
    }
    this._outputFormat = outputFormat;
    const changed = oldVoice !== this._voice
      || oldOutputFormat !== this._outputFormat
      || oldOptions !== JSON.stringify(this._metadataOptions);
    if (!changed && !this._clientInit && this._ws?.readyState === WebSocket.OPEN
      && !this._retiredSockets.includes(this._ws)) {
      return;
    }
    // create new client
    this._startTime = Date.now();
    await this._initClient();
  }

  private _metadataCheck(): void {
    if (!this._ws) throw new Error('Speech synthesis not configured yet. Run setMetadata before calling toStream or toFile.');
  }

  /** Close the WebSocket connection. */
  close(): void {
    this._clientGeneration++;
    const sockets = new Set(this._retiredSockets);
    if (this._ws) sockets.add(this._ws);
    this._retiredSockets = [];
    for (const stream of Object.values(this._streams)) {
      clearTimeout(stream.timeout);
      if (!stream.turnEnded) {
        stream.audio.destroy(new Error('Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.'));
      }
    }
    sockets.forEach((socket) => this._closeSocket(socket));
  }

  /** Writes raw audio synthesised from text to a file, through the SSML template. */
  async toFile(dirPath: string, input: string, options?: ProsodyInput): Promise<{ audioFilePath: string; metadataFilePath: string | null; requestId: string }> {
    return this._rawSSMLRequestToFile(dirPath, this._SSMLTemplate(input, options));
  }

  /** Writes raw audio synthesised from text in real-time to streams, through the SSML template. */
  toStream(input: string, options?: ProsodyInput): { audioStream: Readable; metadataStream: Readable | null; requestId: string } {
    return this._rawSSMLRequest(this._SSMLTemplate(input, options));
  }

  /** Writes raw audio synthesised from a ready SSML request to a file. */
  async rawToFile(dirPath: string, requestSSML: string): Promise<{ audioFilePath: string; metadataFilePath: string | null; requestId: string }> {
    return this._rawSSMLRequestToFile(dirPath, requestSSML);
  }

  /** Writes raw audio synthesised from a ready SSML request in real-time to streams. */
  rawToStream(requestSSML: string): { audioStream: Readable; metadataStream: Readable | null; requestId: string } {
    return this._rawSSMLRequest(requestSSML);
  }

  private _hasMetadataBoundaries(): boolean {
    return this._metadataOptions.sentenceBoundaryEnabled
      || this._metadataOptions.wordBoundaryEnabled;
  }

  private async _rawSSMLRequestToFile(dirPath: string, requestSSML: string): Promise<{ audioFilePath: string; metadataFilePath: string | null; requestId: string }> {
    const { audioStream, metadataStream, requestId } = this._rawSSMLRequest(requestSSML);
    const audioFilePath = join(dirPath, 'audio.' + OUTPUT_EXTENSIONS[this._outputFormat]);
    const metadataFilePath = metadataStream ? join(dirPath, 'metadata.json') : null;
    try {
      await Promise.all([
        new Promise<string>((resolve, reject) => {
          const writableAudioFile = audioStream.pipe(createWriteStream(audioFilePath));
          // .pipe() doesn't forward source errors to the writable, so a truncated stream
          // would hang here — watch the audio stream directly and reject on its error
          audioStream.once('error', (e) => {
            writableAudioFile.destroy();
            reject(e);
          });
          writableAudioFile.once('close', () => {
            if (writableAudioFile.bytesWritten > 0) {
              resolve(audioFilePath);
            }
            else {
              reject(new Error('No audio data received'));
              rmSync(audioFilePath, { force: true });
            }
          });
          writableAudioFile.once('error', reject);
        }),
        new Promise<string | null>((resolve, reject) => {
          const meta = metadataStream;
          if (!meta || !metadataFilePath) {
            return resolve(null);
          }
          // get metadata from buffer and combine all MetaData root elements
          const metadataItems = { Metadata: [] as unknown[] };
          meta.on('data', (chunk) => {
            const chunkObj = JSON.parse(chunk.toString());
            // .Metadata is an array of objects, just combine them
            metadataItems.Metadata.push(...chunkObj['Metadata']);
          });
          meta.once('close', () => {
            if (metadataItems.Metadata.length > 0) {
              writeFileSync(metadataFilePath, JSON.stringify(metadataItems, null, 2));
              resolve(metadataFilePath);
            }
            else {
              reject(new Error('No metadata received'));
              rmSync(metadataFilePath, { force: true });
            }
          });
          meta.once('error', reject);
        }),
      ]);
      return { audioFilePath, metadataFilePath, requestId };
    }
    catch (e) {
      audioStream.destroy();
      metadataStream?.destroy();
      throw e;
    }
  }

  private static randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  private _rawSSMLRequest(requestSSML: string): { audioStream: Readable; metadataStream: Readable | null; requestId: string } {
    this._metadataCheck();
    const requestId = MsEdgeTTS.randomHex(16);
    const request = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:${messageTypes.SSML}${MsEdgeTTS.JSON_XML_DELIM}` + requestSSML.trim();
    // https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/speech-synthesis-markup
    const self = this;
    const audioStream = new Readable({
      read() {
      },
      destroy(error, callback) {
        clearTimeout(self._streams[requestId]?.timeout);
        delete self._streams[requestId];
        self._closeRetiredSockets();
        callback(error);
      },
    });
    const metadataStream = this._hasMetadataBoundaries() ? new Readable({
      read() {
      },
    }) : null;
    audioStream.on('error', () => {
      audioStream.destroy();
      metadataStream?.destroy();
    });
    audioStream.once('close', () => {
      audioStream.destroy();
      metadataStream?.destroy();
    });
    this._streams[requestId] = {
      audio: audioStream,
      metadata: metadataStream,
      turnEnded: false,
    };
    this._send(request, requestId).catch((error: Error) => {
      // surface _send/reconnect failures on the audio stream instead of an unhandled
      // rejection that crashes the host process
      this._streams[requestId]?.audio.destroy(error);
    });
    return { audioStream, metadataStream, requestId };
  }
}
