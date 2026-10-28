/**
 * The WebUI panel for the bridge: the Host half's address, the conversation its notices belong
 * to, and the protocol revision both halves speak. A pair of buttons lets the person pin the
 * pet to the current session so it keeps speaking into it even after DSH moves the default
 * owner elsewhere, a button that starts a new DSH conversation when none is open, plus a test
 * button to force-read the bridge state and confirm the session id has refreshed after an
 * auto-repick.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { SessionList } from '../client.ts';
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
    const picker = ui.h('div');
    const actions = ui.rowbar();
    const msg = ui.h('div');
    sheet.body.append(status, facts, picker, actions, msg);
    ctx.root.appendChild(sheet.el);

    // Runtime WebUi only types a subset of its own factory; cast is needed.
    const asUi = ui as unknown as {
      button(label: string, opts?: { size?: string; variant?: string; onClick?: () => void }): HTMLElement;
    };

    const newBtn = asUi.button(t.panel.newSession, { size: 'sm', variant: 'primary' });
    const bindBtn = asUi.button(t.panel.bind, { size: 'sm' });
    const unbindBtn = asUi.button(t.panel.unbind, { size: 'sm' });
    const testBtn = asUi.button(t.panel.testRefresh, { size: 'sm' });
    const pickBtn = asUi.button(t.panel.pickSession, { size: 'sm' });

    /** True while bind/unbind is in flight so a poll racing the invoke does not clobber the UI. */
    let pending = false;
    /** The last state we rendered, used by the test button to diff-before/after. */
    let last: BridgeState | null = null;
    /** The rows of the last `list-sessions` answer, so a poll can re-mark them while open. */
    let listed: SessionList['sessions'] | null = null;
    /** Guards against a slow poll landing after a newer read and repainting stale state. */
    let readSeq = 0;

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
      newBtn.toggleAttribute('disabled', !bridge.connected);
      testBtn.toggleAttribute('disabled', !bridge.connected);
      pickBtn.toggleAttribute('disabled', !bridge.connected);
      while (actions.firstChild) actions.removeChild(actions.firstChild);
      actions.append(newBtn, bindBtn, unbindBtn, testBtn, pickBtn);
      // Re-mark the open picker: after a bind/unbind the rows still say "current" / "pinned"
      // for the old session, which reads as "nothing refreshed".
      renderRows();
    };

    const refresh = async (): Promise<BridgeState | null> => {
      const seq = ++readSeq;
      try {
        const state = await ctx.invoke<BridgeState>('state');
        // A poll issued before a bind/unbind can answer after it; only the newest read paints.
        if (seq !== readSeq) return state;
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
        if (pickerOpen) await reloadRows();
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
        // The pin moved in the Host too; an open picker would keep showing the old mark.
        if (pickerOpen) await reloadRows();
      }
    };

    const startSession = async (): Promise<void> => {
      pending = true;
      msg.textContent = '';
      try {
        const result = await ctx.invoke<{ ok: boolean; session: string }>('new');
        msg.textContent = t.panel.created(result.session);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        msg.textContent = reason === 'unsent' ? t.panel.notConnected : t.panel.createFailed + reason;
      } finally {
        pending = false;
        await refresh();
      }
    };

    /** 点一下强制重读：状态 + 打开的会话列表都重新拉一遍（快速切换后用）。 */
    const testRefresh = async (): Promise<void> => {
      msg.textContent = '';
      const before = last;
      const after = await refresh();
      if (!after) {
        msg.textContent = t.panel.testFailed;
        return;
      }
      // A rapid round of tab switches leaves the list marks guessing; reload it with the state.
      if (pickerOpen) await reloadRows();
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

    /**
     * The explicit session picker. DSH stays silent when a person merely switches tabs — no
     * session/event fires — so auto-follow cannot see silent navigation. Listing the live sessions
     * and binding a chosen one replaces mind-reading. The list is a snapshot taken when opened;
     * reopening refreshes it. Subagents are hidden: the Host refuses them anyway.
     */
    let pickerOpen = false;

    const closePicker = (): void => {
      pickerOpen = false;
      listed = null;
      picker.textContent = '';
      pickBtn.textContent = t.panel.pickSession;
    };

    /** Paint the open picker from `listed`, re-marking current / pinned / owner. */
    function renderRows(): void {
      if (!pickerOpen || !listed) return;
      picker.textContent = '';
      const rows = listed.filter((s) => !s.subagent);
      if (!rows.length) {
        picker.textContent = t.panel.noSessions;
        return;
      }
      const active = last?.pinned ?? last?.session;
      for (const s of rows) {
        const id = s.id;
        const shortId = (id.startsWith('session-') ? id.slice(8) : id).slice(0, 8);
        const folder = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
        const marks: string[] = [];
        if (active && id === active) marks.push(t.panel.current);
        if (s.pinned) marks.push(t.panel.pinned);
        else if (s.owner) marks.push(t.panel.owner);
        const btn = asUi.button(
          `${shortId}${folder ? ` · ${folder}` : ''}${marks.length ? `（${marks.join('·')}）` : ''}`,
          { size: 'sm' },
        );
        btn.addEventListener('click', () => void pickRow(id));
        picker.append(btn);
      }
    }

    const pickRow = async (id: string): Promise<void> => {
      pending = true;
      msg.textContent = '';
      try {
        const result = await ctx.invoke<{ ok: boolean; session: string }>('bind', [id]);
        msg.textContent = t.panel.bound(result.session);
        closePicker();
      } catch (err: unknown) {
        msg.textContent = t.panel.bindFailed + (err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
        await refresh();
      }
    };

    /** Re-read the session list for the open picker; the Host's pin state may have moved. */
    const reloadRows = async (): Promise<void> => {
      try {
        const list = await ctx.invoke<SessionList | null>('listSessions');
        if (!pickerOpen) return; // closed while the list was loading
        if (!list) {
          // `null` means the Host never answered — say that, rather than claiming DSH has no sessions.
          listed = null;
          picker.textContent = t.panel.listFailed;
          return;
        }
        listed = list.sessions;
        renderRows();
      } catch {
        closePicker();
        msg.textContent = t.panel.notConnected;
      }
    };

    const togglePicker = async (): Promise<void> => {
      if (pickerOpen) {
        closePicker();
        return;
      }
      pickerOpen = true;
      pickBtn.textContent = t.panel.pickHide;
      await reloadRows();
    };

    newBtn.addEventListener('click', () => void startSession());
    bindBtn.addEventListener('click', () => void bindCurrent());
    unbindBtn.addEventListener('click', () => void unbind());
    testBtn.addEventListener('click', () => void testRefresh());
    pickBtn.addEventListener('click', () => void togglePicker());

    await refresh();
    ctx.interval(() => void refresh(), POLL_MS);
  },
};

export default { panels: { dsh: bridgePanel } } satisfies WebUiClientBundle;
