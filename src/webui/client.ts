/**
 * The WebUI panel for the bridge: the Host half's address, the conversation its notices belong
 * to, and the protocol revision both halves speak. Everything comes from this World's own `state`,
 * read through `ctx.invoke`; the panel edits nothing.
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
    sheet.body.append(status, facts);
    ctx.root.appendChild(sheet.el);

    const show = (bridge: BridgeState): void => {
      status.replaceChildren(
        ui.chip(bridge.connected ? t.lamps.connected : t.lamps.offline, bridge.connected ? 'accent' : 'warn'),
        ui.chip(`${t.panel.protocol} v${bridge.protocol}`),
      );
      facts.replaceChildren(ui.kv([
        { k: t.panel.url, v: bridge.url || '—' },
        { k: t.panel.session, v: bridge.session || '—' },
        { k: t.panel.model, v: bridge.model || '—' },
      ]));
    };

    const refresh = async (): Promise<void> => {
      try {
        show(await ctx.invoke<BridgeState>('state'));
      } catch {
        // a failing invoke is drawn by the WebUI as this panel's error card
      }
    };

    await refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { dsh: bridgePanel } } satisfies WebUiClientBundle;
