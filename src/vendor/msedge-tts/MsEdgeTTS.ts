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
    const reqId = MsEdgeTTS.generateUUID();
    const secMsGec = await MsEdgeTTS.generateSecMsGec(MsEdgeTTS.TRUSTED_CLIENT_TOKEN);
    return `${MsEdgeTTS.WSS_URL}?Ocp-Apim-Subscription-Key=${MsEdgeTTS.TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${reqId}`;
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        // api.msedgeservices.com answers `HTTP 200` instead of `101 Switching Protocols`
        // unless the handshake carries the header set its Edge client sends. UA + Origin
        // alone is not enough: Electron's Node (and, on this endpoint, plain Node too)
        // gets the 200, which the `ws` client surfaces as `Unexpected server response: 200`.
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-CH-UA': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'websocket',
        'Sec-Fetch-Site': 'none',
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

  static async generateSecMsGec(trustedClientToken: string): Promise<string> {
    const ticks = Math.floor((Date.now() + MsEdgeTTS._clockOffsetMs) / 1000) + 11644473600;
    const rounded = ticks - (ticks % 300);
    const windowsTicks = rounded * 10_000_000;
    const data = new TextEncoder().encode(`${windowsTicks}${trustedClientToken}`);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
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
