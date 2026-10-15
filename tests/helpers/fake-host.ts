/**
 * World 测试共用的 fake host：记录推送的事件与唤醒口径。`deliver: false` 的事件只落库，记在 stored，
 * 不进 events；store.range 按落库顺序读两者。本仓库独立分发，没有 Core 的 LogBlobStore 可依赖，
 * blob 相关成员以空实现代替（本包的事件不携带附件）。其余宿主接口都是空实现。
 */
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  /** 投递给 bot 的事件。 */
  events: EventEnvelope[] = [];
  /** 只落库、不投递的事件。 */
  stored: EventEnvelope[] = [];
  private all: EventEnvelope[] = [];
  pushDeferred(): void {}
  store = {
    get: (cursor: number) => this.all.find((e) => e.cursor === cursor),
    latestCursor: () => this.all.length,
    range: (q: { source?: string; toCursor?: number; limit?: number }) => {
      const hit = this.all.filter((e) => (!q.source || e.source === q.source) && (q.toCursor === undefined || e.cursor <= q.toCursor));
      return q.limit === undefined ? hit : hit.slice(-q.limit);
    },
  } as unknown as WorldHost['store'];
  blob = (): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 与 events 逐条对齐：唤醒/攒批的口径也要能断言 */
  pushOpts: Array<Record<string, unknown> | undefined> = [];

  async pushEvent(e: Parameters<WorldHost['pushEvent']>[0], opts?: Record<string, unknown>): Promise<EventEnvelope> {
    const deliver = opts?.deliver !== false;
    const full = { ...e, cursor: this.all.length + 1, origin: 'external', contextDelivery: deliver ? 'deliver' : 'archive-only' } as EventEnvelope;
    this.all.push(full);
    if (!deliver) {
      this.stored.push(full);
      return full;
    }
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  async withdrawPending(): Promise<boolean> {
    return false;
  }
  async promotePending(): Promise<boolean> {
    return false;
  }
  reportUsage(): void {}
}
