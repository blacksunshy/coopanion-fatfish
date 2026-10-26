/**
 * The WebUI panel for the bridge: the Host half's address, the conversation its notices belong
 * to, and the protocol revision both halves speak. A pair of buttons lets the person pin the
 * pet to the current session so it keeps speaking into it even after DSH moves the default
 * owner elsewhere, plus a test button to force-read the bridge state and confirm the session
 * id has refreshed after an auto-repick.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { fatfishText } from '../i18n/index.ts';

/** One read of `state()` on the Core side. */
interface BridgeState {
  connected: boolean;
  url: string;
  session: string;
  model: string;
  protocol: number;
  /** Non-null when the pet is pinned to this session. */
  pinned: string | null;
}

/** How often the panel re-reads the bridge; the socket changes state without sending a notice. */
const POLL_MS = 3000;

const bridgePanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext): Promise<void> {
    const { ui } = ctx;
    const t = fatfishText(ctx.language);
    const sheet = ui.sheet({ title: t.panel.title, desc: t.panel.desc });
    const status = ui.rowbar();
    const facts = ui.h('div');
    const actions = ui.rowbar();
    const msg = ui.h('div');
    sheet.body.append(status, facts, actions, msg);
    ctx.root.appendChild(sheet.el);

    // Runtime WebUi only types a subset of its own factory; cast is needed.
    const asUi = ui as unknown as {
      button(label: string, opts?: { size?: string; variant?: string; onClick?: () => void }): HTMLElement;
    };

    const bindBtn = asUi.button(t.panel.bind, { size: 'sm', variant: 'primary' });
    const unbindBtn = asUi.button(t.panel.unbind, { size: 'sm' });
    const testBtn = asUi.button(t.panel.testRefresh, { size: 'sm' });

    /** True while bind/unbind is in flight so a poll racing the invoke does not clobber the UI. */
    let pending = false;
    /** The last state we rendered, used by the test button to diff-before/after. */
    let last: BridgeState | null = null;

    const show = (bridge: BridgeState): void => {
      last = bridge;
      // --- chips ---
      while (status.firstChild) status.removeChild(status.firstChild);
      status.append(
        ui.chip(bridge.connected ? t.lamps.connected : t.lamps.offline, bridge.connected ? 'accent' : 'warn'),
        ui.chip(`${t.panel.protocol} v${bridge.protocol}`),
        ...(bridge.pinned ? [ui.chip(t.panel.pinned, 'accent')] : []),
      );
      // --- kv rows ---
      while (facts.firstChild) facts.removeChild(facts.firstChild);
      const candidates: Array<{ k: string; v: string } | null> = [
        { k: t.panel.url, v: bridge.url || '—' },
        bridge.pinned
          ? { k: t.panel.pinned, v: bridge.pinned }
          : bridge.session
            ? { k: t.panel.session, v: bridge.session }
            : null,
        bridge.pinned && bridge.session && bridge.session !== bridge.pinned
          ? { k: t.panel.following, v: bridge.session }
          : null,
        { k: t.panel.model, v: bridge.model || '—' },
      ];
      const rows = candidates.filter((r): r is { k: string; v: string } => r !== null);
      facts.append(ui.kv(rows));
      // --- buttons ---
      if (!pending) {
        bindBtn.toggleAttribute('disabled', !bridge.connected || !bridge.session || bridge.pinned === bridge.session);
        unbindBtn.toggleAttribute('disabled', !bridge.pinned);
      }
      testBtn.toggleAttribute('disabled', !bridge.connected);
      while (actions.firstChild) actions.removeChild(actions.firstChild);
      actions.append(bindBtn, unbindBtn, testBtn);
    };

    const refresh = async (): Promise<BridgeState | null> => {
      try {
        const state = await ctx.invoke<BridgeState>('state');
        show(state);
        return state;
      } catch {
        return null;
      }
    };

    const bindCurrent = async (): Promise<void> => {
      pending = true;
      msg.textContent = '';
      try {
        const state = await ctx.invoke<BridgeState>('state');
        if (!state.connected || !state.session) {
          msg.textContent = t.panel.notConnected;
          return;
        }
        const result = await ctx.invoke<{ ok: boolean; session: string }>('bind', [state.session]);
        msg.textContent = t.panel.bound(result.session);
      } catch (err: unknown) {
        msg.textContent = t.panel.bindFailed + (err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
        await refresh();
      }
    };

    const unbind = async (): Promise<void> => {
      pending = true;
      msg.textContent = '';
      try {
        await ctx.invoke<{ ok: boolean }>('unbind');
        msg.textContent = t.panel.unbound;
      } catch (err: unknown) {
        msg.textContent = t.panel.unbindFailed + (err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
        await refresh();
      }
    };

    /** 点一下强制读一次 bridge 状态，显示 session id / model 是否变了（用于验证 auto re-pick 生效）。 */
    const testRefresh = async (): Promise<void> => {
      msg.textContent = '';
      const before = last;
      const after = await refresh();
      if (!after) {
        msg.textContent = t.panel.testFailed;
        return;
      }
      if (!before) {
        msg.textContent = t.panel.testResult(after.session, after.model);
        return;
      }
      const sessionChanged = before.session !== after.session;
      const modelChanged = before.model !== after.model;
      msg.textContent = t.panel.testResult(
        after.session || '—',
        after.model || '—',
        sessionChanged,
        modelChanged,
      );
    };

    bindBtn.addEventListener('click', () => void bindCurrent());
    unbindBtn.addEventListener('click', () => void unbind());
    testBtn.addEventListener('click', () => void testRefresh());

    await refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { dsh: bridgePanel } } satisfies WebUiClientBundle;
