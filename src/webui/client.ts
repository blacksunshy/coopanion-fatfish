/**
 * The WebUI panel for the bridge: the Host half's address, the conversation its notices belong
 * to, and the protocol revision both halves speak. A pair of buttons lets the person pin the
 * pet to the current session so it keeps speaking into it even after DSH moves the default
 * owner elsewhere.
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

    // These come from the runtime WebUi client; the local type shell only names a subset, so
    // cast is needed on each call.
    const asUi = ui as unknown as {
      button(label: string, opts?: { size?: string; variant?: string; onClick?: () => void }): HTMLElement;
      refresh(): void;
    };

    const bindBtn = asUi.button(t.panel.bind, { size: 'sm', variant: 'primary' });
    const unbindBtn = asUi.button(t.panel.unbind, { size: 'sm' });

    const show = (bridge: BridgeState): void => {
      const chips: HTMLElement[] = [
        ui.chip(bridge.connected ? t.lamps.connected : t.lamps.offline, bridge.connected ? 'accent' : 'warn'),
        ui.chip(`${t.panel.protocol} v${bridge.protocol}`),
      ];
      if (bridge.pinned) chips.push(ui.chip(t.panel.pinned, 'accent'));
      for (const chip of chips) status.appendChild(chip);
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
      const kv = ui.kv(rows);
      facts.appendChild(kv);
      bindBtn.setAttribute('disabled', (!bridge.connected || !bridge.session || bridge.pinned === bridge.session) ? '' : '');
      unbindBtn.setAttribute('disabled', bridge.pinned ? '' : '');
      actions.append(bindBtn, unbindBtn);
    };

    const clearAll = (...els: HTMLElement[]): void => {
      for (const el of els) while (el.firstChild) el.removeChild(el.firstChild);
    };

    const refresh = async (): Promise<void> => {
      try {
        clearAll(status, facts, actions);
        show(await ctx.invoke<BridgeState>('state'));
      } catch {
        // a failing invoke is drawn by the WebUI as this panel's error card
      }
    };

    const bindCurrent = async (): Promise<void> => {
      try {
        msg.textContent = '';
        const state = await ctx.invoke<BridgeState>('state');
        if (!state.connected || !state.session) {
          msg.textContent = t.panel.notConnected;
          return;
        }
        await ctx.invoke<{ ok: boolean; session: string }>('bind', [state.session]);
        msg.textContent = t.panel.bound(state.session);
        await refresh();
      } catch (err: unknown) {
        msg.textContent = t.panel.bindFailed + (err instanceof Error ? err.message : String(err));
      }
    };

    const unbind = async (): Promise<void> => {
      try {
        msg.textContent = '';
        await ctx.invoke<{ ok: boolean }>('unbind');
        msg.textContent = t.panel.unbound;
        await refresh();
      } catch (err: unknown) {
        msg.textContent = t.panel.unbindFailed + (err instanceof Error ? err.message : String(err));
      }
    };

    bindBtn.addEventListener('click', () => void bindCurrent());
    unbindBtn.addEventListener('click', () => void unbind());

    await refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { dsh: bridgePanel } } satisfies WebUiClientBundle;
