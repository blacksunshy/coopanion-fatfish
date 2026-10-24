/**
 * The bridge half of the pack: what DSH progress becomes, what the bot may send back, and which of
 * the person's lines the bridge must not echo.
 *
 * The Host is a real socket speaking the other package's frames; the event store is the shared
 * `FakeHost`, so a notice is asserted where Core would see it rather than where this World put it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { FatfishWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const running: Array<{ world: FatfishWorld; http: Server; wss: WebSocketServer }> = [];

afterEach(async () => {
  for (const entry of running.splice(0)) {
    await entry.world.stop();
    entry.wss.close();
    await new Promise<void>((done) => entry.http.close(() => done()));
  }
});

/** A DSH Host on its own port; `after` runs for every frame the pet sends. */
async function withHost(after?: (socket: WebSocket, frame: Record<string, unknown>) => void, cfg: Record<string, unknown> = {}): Promise<{ world: FatfishWorld; host: FakeHost; fromPet: Array<Record<string, unknown>> }> {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  const fromPet: Array<Record<string, unknown>> = [];
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        fromPet.push(frame);
        if (frame.t === 'hello') ws.send(JSON.stringify({ t: 'ready', v: 1, session: 'session-9', cwd: '/w', model: 'deepseek-flash' }));
        after?.(ws, frame);
      });
    });
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', () => done()));
  const { port } = http.address() as AddressInfo;
  const host = new FakeHost();
  const world = new FatfishWorld({ cfg: { url: `ws://127.0.0.1:${port}/coopanion/pet`, ...cfg } as never });
  running.push({ world, http, wss });
  await world.start(host as never);
  await until(() => world.state().connected === true);
  return { world, host, fromPet };
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

/** The texts of the notices this World pushed. */
const notices = (host: FakeHost): string[] => host.events.filter((e: EventEnvelope) => e.source === 'fatfish').map((e: EventEnvelope) => e.text);

describe('what DSH progress becomes', () => {
  it('is one notice per event the person would want to see', async () => {
    const { host } = await withHost((socket, frame) => {
      if (frame.t !== 'hello') return;
      for (const notice of [
        { t: 'turn-start', turn: 7 },
        { t: 'tool', name: 'read', detail: '{"path":"a.ts"}' },
        { t: 'reply', turn: 7, text: '做完了' },
        { t: 'turn-end', turn: 7, reason: 'completed' },
      ]) socket.send(JSON.stringify(notice));
    });
    await until(() => notices(host).length >= 4);
    const text = notices(host).join('\n');
    expect(text).toContain('第 7 轮开始');
    expect(text).toContain('调用工具 read');
    expect(text).toContain('做完了');
    expect(text).toContain('第 7 轮结束（completed）');
  });

  it('is a notice even when DSH is waiting on the person', async () => {
    const { host } = await withHost((socket, frame) => {
      if (frame.t !== 'hello') return;
      socket.send(JSON.stringify({ t: 'approval', name: 'write', reason: 'outside the workspace' }));
      socket.send(JSON.stringify({ t: 'question', text: '要不要继续？' }));
    });
    await until(() => notices(host).length >= 2);
    expect(notices(host).join('\n')).toContain('批准 write');
    expect(notices(host).join('\n')).toContain('要不要继续？');
  });
});

describe('a line the bot hands to DSH', () => {
  it('goes out on the socket and its receipt says it arrived', async () => {
    const { world, fromPet } = await withHost((socket, frame) => {
      if (frame.t === 'say') socket.send(JSON.stringify({ t: 'accepted', id: frame.id }));
    });
    const tool = world.tools().find((t) => t.name === 'dsh_send')!;
    await until(() => fromPet.length >= 1);
    expect(await tool.handler({ text: '帮我看下构建' }, {} as never)).toBe('已交给 DSH。');
    expect(fromPet.find((f) => f.t === 'say')).toMatchObject({ text: '帮我看下构建' });
  });

  it('reports the refusal instead of pretending it arrived', async () => {
    const { world } = await withHost((socket, frame) => {
      if (frame.t === 'say') socket.send(JSON.stringify({ t: 'refused', id: frame.id, reason: 'no conversation is open on the DSH side' }));
    });
    const tool = world.tools().find((t) => t.name === 'dsh_send')!;
    expect(await tool.handler({ text: 'hi' }, {} as never)).toBe('没有交给 DSH：no conversation is open on the DSH side');
  });

  it('fails with a receipt instead of a crash when the bridge is switched off', async () => {
    const host = new FakeHost();
    const world = new FatfishWorld({ cfg: { url: 'ws://127.0.0.1:1/coopanion/pet', bridgeEnabled: false } as never });
    await world.start(host as never);
    const tool = world.tools().find((t) => t.name === 'dsh_send')!;
    expect(await tool.handler({ text: 'hi' }, {} as never)).toBe('没有交给 DSH：（DSH 未连接）');
    expect(world.envPromptVars()['dsh.status']).toBe('off');
    await world.stop();
  });
});

describe('what the bot reads about DSH', () => {
  it('says which conversation it is bridged to', async () => {
    const { world } = await withHost();
    expect(world.envPromptVars()['dsh.status']).toContain('session-9');
    expect(world.envPromptVars()['dsh.status']).toContain('deepseek-flash');
  });
});

describe('the person\'s own lines', () => {
  it('are relayed to DSH', async () => {
    const { host, fromPet } = await withHost();
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '你帮我看看', meta: { via: 'chat', text: '你帮我看看' } } as never);
    await until(() => fromPet.some((f) => f.t === 'say'));
    expect(fromPet.find((f) => f.t === 'say')).toMatchObject({ text: '你帮我看看' });
  });

  it('are followed by a notice that the bridge already carried them', async () => {
    const { host, fromPet } = await withHost((socket, frame) => {
      if (frame.t === 'say') socket.send(JSON.stringify({ t: 'accepted', id: frame.id }));
    });
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '你帮我看看', meta: { via: 'chat', text: '你帮我看看' } } as never);
    await until(() => fromPet.some((f) => f.t === 'say'));
    await until(() => notices(host).some((text: string) => text.includes('不必再转一次')));
    expect(notices(host).join('\n')).toContain('你帮我看看');
  });

  it('are not handed over again after a restart, which reads only newer lines', async () => {
    const { world, host, fromPet } = await withHost((socket, frame) => {
      if (frame.t === 'say') socket.send(JSON.stringify({ t: 'accepted', id: frame.id }));
    });
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '重启前的一句', meta: { via: 'chat', text: '重启前的一句' } } as never);
    await until(() => fromPet.some((f) => f.t === 'say'));
    await until(() => notices(host).some((text: string) => text.includes('不必再转一次')));

    await world.stop();
    const restarted = new FatfishWorld({ cfg: { url: world.state().url as string } } as never);
    await restarted.start(host as never);
    await until(() => restarted.state().connected === true);
    // two full scan cycles: the restart starts at the newest event, so the old line
    // had every chance to be handed over again if the restart re-read it
    await new Promise((done) => setTimeout(done, 4600));
    expect(fromPet.filter((f) => f.t === 'say')).toHaveLength(1);
    await restarted.stop();
  });

  it('stay with the pet when the bridge is told not to relay them', async () => {
    const { host, fromPet } = await withHost(undefined, { relayPerson: false });
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '只跟 Coo 说的', meta: { via: 'chat', text: '只跟 Coo 说的' } } as never);
    // a full scan cycle, to prove the relay guard held
    await new Promise((done) => setTimeout(done, 2600));
    expect(fromPet.some((f) => f.t === 'say')).toBe(false);
  });

  it('are not echoed back when DSH was the one who said them', async () => {
    const { host, fromPet } = await withHost();
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '来自 DSH', meta: { via: 'dsh', relayed: true, text: '来自 DSH' } } as never);
    // give the scan a full cycle to prove it stayed quiet
    await new Promise((done) => setTimeout(done, 2600));
    expect(fromPet.some((f) => f.t === 'say')).toBe(false);
  });
});

describe('the pet\'s own lines (relayPet)', () => {
  it('are carried to DSH silently, with no receipt the bot could comment on', async () => {
    const { host, fromPet } = await withHost(undefined, { relayPet: true });
    await host.pushEvent({
      type: 'desktop-pet.self',
      source: 'desktop-pet',
      ts: new Date().toISOString(),
      text: '我自己说的',
      meta: { kind: 'say', beats: [{ text: '我自己说的' }] },
    } as never);
    await until(() => fromPet.some((f) => f.t === 'say'));
    expect(fromPet.find((f) => f.t === 'say')).toMatchObject({ text: '我自己说的' });
    // a full scan cycle later, still no receipt: the bot has nothing to re-send here
    await new Promise((done) => setTimeout(done, 400));
    expect(notices(host)).toHaveLength(0);
  });

  it('stay local when relayPet is off', async () => {
    const { host, fromPet } = await withHost(undefined, { relayPet: false });
    await host.pushEvent({
      type: 'desktop-pet.self',
      source: 'desktop-pet',
      ts: new Date().toISOString(),
      text: '我自己说的',
      meta: { kind: 'say', beats: [{ text: '我自己说的' }] },
    } as never);
    await new Promise((done) => setTimeout(done, 400));
    expect(fromPet.some((f) => f.t === 'say')).toBe(false);
  });
});

describe('what the bot is told about handing a line over', () => {
  it('is that the person\'s lines are its own to carry when relaying them is off', async () => {
    const { world } = await withHost(undefined, { relayPerson: false });
    const tool = world.tools().find((t) => t.name === 'dsh_send')!;
    expect(tool.description).toContain('do not reach DSH on their own');
  });
});

describe('when the bridge cannot connect', () => {
  /**
   * These two own the exact address, so the loopback fallback is off: with it on, a Host already
   * running on the developer's machine would answer the sweep before the listener this test starts,
   * and the assertions would be about that Host instead.
   */
  /** A port nothing listens on yet; the DSH Host may arrive late on it. */
  async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((done) => srv.close(() => done()));
    return port;
  }

  it('queues lines during the grace window and hands them over when DSH arrives late', async () => {
    const port = await freePort();
    const host = new FakeHost();
    const world = new FatfishWorld({ cfg: { url: `ws://127.0.0.1:${port}/coopanion/pet` }, discover: false } as never);
    await world.start(host as never);
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '迟到前的一句', meta: { via: 'chat', text: '迟到前的一句' } } as never);
    await until(() => (world as unknown as { pending: Array<{ text: string }> }).pending.length === 1);
    expect(notices(host)).toHaveLength(0); // still inside the grace window: nothing dropped, nothing announced

    // DSH shows up on the very port the retry loop keeps circling
    const wss = new WebSocketServer({ noServer: true });
    const http = createServer();
    const fromPet: Array<Record<string, unknown>> = [];
    http.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          fromPet.push(frame);
          if (frame.t === 'hello') ws.send(JSON.stringify({ t: 'ready', v: 1, session: 'session-late', cwd: '/w', model: 'deepseek-flash' }));
          if (frame.t === 'say') ws.send(JSON.stringify({ t: 'accepted', id: frame.id }));
        });
      });
    });
    await new Promise<void>((done) => http.listen(port, '127.0.0.1', () => done()));
    await until(() => world.state().connected === true, 6000);
    await until(() => fromPet.some((f) => f.t === 'say'));
    expect(fromPet.find((f) => f.t === 'say')).toMatchObject({ text: '迟到前的一句' });
    await world.stop();
    wss.close();
    await new Promise<void>((done) => http.close(() => done()));
  });

  it('lets lines go silently once the grace window has passed and no DSH has ever shown up', async () => {
    const port = await freePort();
    const host = new FakeHost();
    const world = new FatfishWorld({ cfg: { url: `ws://127.0.0.1:${port}/coopanion/pet` }, discover: false } as never);
    await world.start(host as never);
    // the grace window has passed and the bridge has never connected: a voice-only setup
    (world as unknown as { graceUntil: number }).graceUntil = Date.now() - 1;
    await host.pushEvent({ type: 'desktop-pet.message', source: 'desktop-pet', ts: new Date().toISOString(), text: '没人听的一句', meta: { via: 'chat', text: '没人听的一句' } } as never);
    // a full scan cycle plus a bit: the line was neither queued nor turned into a notice
    await new Promise((done) => setTimeout(done, 2600));
    expect((world as unknown as { pending: Array<unknown> }).pending).toHaveLength(0);
    expect(notices(host)).toHaveLength(0);
    await world.stop();
  });
});
