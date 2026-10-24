/**
 * Finding the DSH Host when the port in the config is stale.
 *
 * The Host rides DSH's own web server, and DSH picks that port at launch — an ephemeral port out
 * of the OS range, different on every restart. So the URL a person typed into the config goes
 * stale the next time DSH boots, and there is no file, env var or fixed default to read the new
 * one from. The only portable way back is to ask the loopback ports that could plausibly be it,
 * and let the Host identify itself: `GET /coopanion/status` answers `{ok:true, v:<protocol>}`.
 *
 * Two phases keep that cheap. Closed ports are rejected by the OS in well under a millisecond, so
 * a parallel TCP sweep finds the handful of live ports without speaking HTTP to any of them; only
 * those candidates get the status request that says whether it is our bridge or something else.
 * The sweep is ~2s for the whole ephemeral range and runs only after a connection has already
 * failed — never on the happy path.
 */
import { connect } from 'node:net';

export interface BridgeStatus {
  /** The port whose `/coopanion/status` answered as the Host. */
  port: number;
  /** The session the Host is bridged to, when it said. */
  session: string | null;
}

export interface DiscoverOptions {
  /** The protocol revision the Host must speak; anything else is not ours. */
  version: number;
  /** Inclusive first port of the sweep. */
  from?: number;
  /** Inclusive last port of the sweep. */
  to?: number;
  /** Sockets kept in flight during the TCP sweep. */
  concurrency?: number;
  /** Budget for one TCP probe, and for the status request that follows it. */
  timeoutMs?: number;
  /** Polled between ports so a World that stopped mid-sweep stops sweeping. */
  shouldStop?: () => boolean;
}

/**
 * The Windows/Linux ephemeral range: what `listen(0)` hands out, which is how DSH chooses.
 * A DSH told to use a fixed port is already covered — the caller tries the configured URL first.
 */
const EPHEMERAL_FROM = 49_152;
const EPHEMERAL_TO = 65_535;

/** Would something accept a TCP connection on this loopback port? */
function reachable(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, family: 4 });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** The Host's own words at this port, or null when the port belongs to something else. */
async function identify(port: number, version: number, timeoutMs: number): Promise<BridgeStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/coopanion/status`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; v?: unknown; session?: unknown };
    if (body?.ok !== true || body?.v !== version) return null;
    return { port, session: typeof body.session === 'string' ? body.session : null };
  } catch {
    return null;
  }
}

/**
 * The first loopback port whose status endpoint answers as this protocol revision, or null when the
 * sweep found nothing. Exceptions are swallowed: a sweep that throws is a sweep that found nothing.
 */
export async function discoverBridge(opts: DiscoverOptions): Promise<BridgeStatus | null> {
  const from = opts.from ?? EPHEMERAL_FROM;
  const to = opts.to ?? EPHEMERAL_TO;
  const concurrency = opts.concurrency ?? 512;
  const timeoutMs = opts.timeoutMs ?? 400;
  const stopped = opts.shouldStop ?? (() => false);

  const candidates: number[] = [];
  let next = from;

  const sweep = async (): Promise<void> => {
    while (next <= to) {
      if (stopped()) return;
      const port = next++;
      if (await reachable(port, timeoutMs)) candidates.push(port);
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) workers.push(sweep());
  await Promise.all(workers);

  if (stopped() || candidates.length === 0) return null;

  // A live port is not necessarily ours: DSH's own Chromium child listens on a handful of them.
  // Asking them all at once keeps the answer bounded by one timeout rather than one per port.
  candidates.sort((a, b) => a - b);
  const identified = await Promise.all(candidates.map((port) => identify(port, opts.version, timeoutMs)));
  return identified.find((found): found is BridgeStatus => found !== null) ?? null;
}
