/**
 * Finding the Host after DSH's port moved, against real loopback servers.
 *
 * The Host answers on whatever port DSH's web server picked at launch, so the only honest way to
 * test discovery is to have something actually listening: a stub that returns the status body would
 * prove that the code parses JSON, not that it can tell a live Host from the other listeners a
 * desktop machine has.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverBridge } from '../src/discover.ts';

const open: Server[] = [];

afterEach(async () => {
  for (const server of open.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/** A loopback listener on some free port; `body` is what `/coopanion/status` answers. */
async function serving(status: number, body: unknown): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url !== '/coopanion/status') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  });
  open.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return { port: (server.address() as AddressInfo).port, server };
}

/** A port that was just free, so nothing is listening there any more. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe('discoverBridge', () => {
  it('finds the Host on a live port and reports the session it is bridged to', async () => {
    const { port } = await serving(200, { ok: true, v: 1, pet: false, session: 'session-abc' });

    await expect(discoverBridge({ version: 1, from: port, to: port })).resolves.toEqual({
      port,
      session: 'session-abc',
    });
  });

  it('reports a null session when the Host has no conversation yet', async () => {
    const { port } = await serving(200, { ok: true, v: 1, session: null });

    await expect(discoverBridge({ version: 1, from: port, to: port })).resolves.toEqual({ port, session: null });
  });

  it('refuses a Host that speaks another protocol revision', async () => {
    const { port } = await serving(200, { ok: true, v: 2, session: 'session-abc' });

    await expect(discoverBridge({ version: 1, from: port, to: port })).resolves.toBeNull();
  });

  it('refuses a listener that is not the Host', async () => {
    const other = await serving(200, { hello: 'not the bridge' });
    const missing = await serving(404, { error: 'not found' });

    await expect(discoverBridge({ version: 1, from: other.port, to: other.port })).resolves.toBeNull();
    await expect(discoverBridge({ version: 1, from: missing.port, to: missing.port })).resolves.toBeNull();
  });

  it('finds nothing when the range holds no listener', async () => {
    const port = await closedPort();

    await expect(discoverBridge({ version: 1, from: port, to: port })).resolves.toBeNull();
  });

  it('gives up as soon as the caller says to stop', async () => {
    const { port } = await serving(200, { ok: true, v: 1, session: 'session-abc' });

    await expect(discoverBridge({ version: 1, from: port, to: port + 5000, shouldStop: () => true })).resolves.toBeNull();
  });
});
