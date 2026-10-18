/**
 * The pet's side of the wire, against a real Host socket that speaks the other package's protocol.
 *
 * The two halves ship separately and keep their own copies of the frame literals, so a test that
 * stubbed the Host would prove nothing about the pair: this one runs a server that sends the frames
 * `coopanion-connector-dsh` sends and checks what this side makes of them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshClient, PROTOCOL_VERSION, parseHostFrame, type DshSession, type HostFrame } from '../src/client.ts';

const open: Array<{ client: DshClient; http: Server; wss: WebSocketServer }> = [];

afterEach(async () => {
  for (const entry of open.splice(0)) {
    try {
      entry.client.stop();
    } catch {
      // a test that already stopped its client leaves nothing to unwind
    }
    entry.wss.close();
    await new Promise<void>((done) => entry.http.close(() => done()));
  }
});

/** A Host that greets a pet and then does whatever the test tells it to. */
async function hosting(script: (socket: WebSocket, hello: Record<string, unknown>) => void): Promise<{
  url: string;
  client: DshClient;
  http: Server;
  frames: HostFrame[];
  states: Array<{ connected: boolean; detail: DshSession | null }>;
  hellos: Array<Record<string, unknown>>;
  /** Counts upgrades, so a test can prove a stopped client made no further attempt. */
  connections: { count: number };
}> {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  const hellos: Array<Record<string, unknown>> = [];
  const frames: HostFrame[] = [];
  const states: Array<{ connected: boolean; detail: DshSession | null }> = [];
  const connections = { count: 0 };
  http.on('upgrade', (req, socket, head) => {
    connections.count += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const hello = JSON.parse(data.toString()) as Record<string, unknown>;
        hellos.push(hello);
        script(ws, hello);
      });
    });
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', () => done()));
  const { port } = http.address() as AddressInfo;
  const client = new DshClient({
    url: () => `ws://127.0.0.1:${port}/coopanion/pet`,
    name: () => 'Coo',
    onFrame: (frame) => frames.push(frame),
    onState: (connected, detail) => states.push({ connected, detail }),
    log: () => {},
  });
  open.push({ client, http, wss });
  client.start();
  return { url: `ws://127.0.0.1:${port}`, client, http, frames, states, hellos, connections };
}

/** Waits until `check` holds, or fails the test. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('condition never held');
}

describe('connecting to the DSH Host', () => {
  it('greets with this package\'s protocol revision and name', async () => {
    const { hellos } = await hosting((socket) => {
      socket.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, session: 's1', cwd: '/w', model: 'deepseek-flash' }));
    });
    await until(() => hellos.length > 0);
    expect(hellos[0]).toEqual({ t: 'hello', v: PROTOCOL_VERSION, name: 'Coo' });
  });

  it('reports the connection with the session and model it landed in', async () => {
    const { states } = await hosting((socket) => {
      socket.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, session: 's1', cwd: '/w', model: 'deepseek-flash' }));
    });
    await until(() => states.some((s) => s.connected));
    expect(states.find((s) => s.connected)?.detail).toEqual({ session: 's1', cwd: '/w', model: 'deepseek-flash' });
  });

  it('hangs up on a Host that speaks another revision', async () => {
    const closed = new Promise<number>((done) => {
      void hosting((socket) => {
        socket.on('close', (code) => done(code));
        socket.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION + 1, session: 's1' }));
      });
    });
    expect(await closed).toBe(1002);
  });

  it('retries after a Host that is not there yet', async () => {
    const states: Array<{ connected: boolean; detail: DshSession | null }> = [];
    const client = new DshClient({
      // nothing listens on this port; the first attempt fails
      url: () => 'ws://127.0.0.1:1/coopanion/pet',
      name: () => 'Coo',
      onFrame: () => {},
      onState: (connected, detail) => states.push({ connected, detail }),
      log: () => {},
    });
    client.start();
    await until(() => states.length > 0);
    expect(states[0]?.connected).toBe(false);
    client.stop();
  });
});

describe('a notice from the Host', () => {
  it('reaches the World as a frame', async () => {
    const { frames } = await hosting((socket) => {
      socket.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, session: 's1' }));
      socket.send(JSON.stringify({ t: 'turn-start', turn: 4 }));
      socket.send(JSON.stringify({ t: 'reply', turn: 4, text: '做完了' }));
    });
    await until(() => frames.length >= 2);
    expect(frames).toEqual([
      { t: 'turn-start', turn: 4 },
      { t: 'reply', turn: 4, text: '做完了' },
    ]);
  });
});

describe('a line the pet sends', () => {
  it('is submitted and confirmed', async () => {
    const { url, hellos } = await hosting((socket, hello) => {
      if (hello.t === 'hello') {
        socket.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, session: 's1' }));
        return;
      }
      socket.send(JSON.stringify({ t: 'accepted', id: hello.id }));
    });
    void url;
    const client = open.at(-1)!.client;
    // the greeting lands first; the say waits for the Host's answer
    await until(() => hellos.length >= 1);
    const refusal = await client.say('让小鲸鱼说句话');
    expect(refusal).toBeNull();
    expect(hellos[1]).toMatchObject({ t: 'say', text: '让小鲸鱼说句话', from: 'Coo' });
  });

  it('reports the reason DSH refused it', async () => {
    const { hellos } = await hosting((socket, hello) => {
      if (hello.t === 'hello') socket.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, session: 's1' }));
      else socket.send(JSON.stringify({ t: 'refused', id: hello.id, reason: 'no conversation is open on the DSH side' }));
    });
    const client = open.at(-1)!.client;
    await until(() => hellos.length >= 1);
    expect(await client.say('hi')).toBe('no conversation is open on the DSH side');
  });

  it('reports unsent without writing when there is no connection', async () => {
    const client = new DshClient({
      url: () => 'ws://127.0.0.1:1/coopanion/pet',
      name: () => 'Coo',
      onFrame: () => {},
      onState: () => {},
      log: () => {},
    });
    // 'unsent' means the line provably never left, so the caller may queue it for a later bridge.
    expect(await client.say('hi')).toBe('unsent');
  });
});

describe('a frame this pet does not understand', () => {
  it('is read when it is one this version knows', () => {
    expect(parseHostFrame('{"t":"ready","v":1,"session":"s","cwd":"/w","model":"m"}')).toEqual({ t: 'ready', v: 1, session: 's', cwd: '/w', model: 'm' });
    expect(parseHostFrame('{"t":"turn-start","turn":2}')).toEqual({ t: 'turn-start', turn: 2 });
    expect(parseHostFrame('{"t":"turn-end","turn":2,"reason":"completed"}')).toEqual({ t: 'turn-end', turn: 2, reason: 'completed' });
  });

  it('is ignored when it is malformed or from a later Host', () => {
    expect(parseHostFrame('{')).toBeNull();
    expect(parseHostFrame('[]')).toBeNull();
    expect(parseHostFrame('{"t":"ready","session":"s"}')).toBeNull();
    expect(parseHostFrame('{"t":"something-new","x":1}')).toBeNull();
    expect(parseHostFrame('{"t":"reply"}')).toBeNull();
  });
});

describe('the client', () => {
  it('does not reconnect after stop', async () => {
    const { client, connections, http } = await hosting(() => {});
    await until(() => connections.count > 0);
    // take the Host away and stop in the same turn, before the retry timer fires
    http.close();
    client.stop();
    const seen = connections.count;
    await new Promise((done) => setTimeout(done, 1600));
    expect(connections.count).toBe(seen);
  });
});
