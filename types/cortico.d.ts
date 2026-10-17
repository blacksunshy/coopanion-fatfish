/**
 * Minimal shells of the Cortico framework types this pack touches.
 *
 * Inside Coopanion the `cortico/*` imports resolve to the framework source via the monorepo
 * tsconfig; this repo ships alone, so the same module names are declared here, close enough to
 * the real shapes for `tsc --noEmit` and the editor. Runtime never loads these: Coopanion's
 * extension loader binds `cortico/*` itself, and the tests only import them as types.
 */

declare module 'cortico/core/language.ts' {
  export type Language = string;
}

declare module 'cortico/core/config-schema.ts' {
  export interface ConfigProperty {
    type?: string;
    title?: string;
    description?: string;
    enum?: readonly string[];
    'x-options'?: string;
    'x-hot'?: boolean;
    'x-suffix'?: string;
    [key: string]: unknown;
  }
  export interface ConfigGroupSchema {
    type: 'object';
    title: string;
    description?: string;
    properties: Record<string, ConfigProperty>;
  }
  export interface ConfigGroup {
    id: string;
    owner: 'core' | 'persona' | `world:${string}` | `provider:${string}`;
    schema: ConfigGroupSchema;
  }
}

declare module 'cortico/core/types.ts' {
  export type EventOrigin = 'external' | 'internal';
  export type EventTag = string;
  export type ToolTag = string;

  export interface EventEnvelope {
    cursor: number;
    run?: string;
    type: string;
    ts: string;
    source: string;
    origin: EventOrigin;
    tags?: readonly EventTag[];
    contextDelivery?: 'deliver' | 'archive-only';
    text: string;
    senderKey?: string;
    meta?: Record<string, unknown>;
    blobs?: unknown[];
  }

  export interface PushOptions {
    trigger?: string;
    [key: string]: unknown;
  }

  /** Reader over the event store; the pack only reads ranges and the newest cursor. */
  export interface EventStoreReader {
    range(opts?: { fromCursor?: number; toCursor?: number; limit?: number }): EventEnvelope[];
    latestCursor(): number;
  }

  export interface Logger {
    info(text: string): void;
    warn(text: string): void;
    error(text: string): void;
    debug(text: string): void;
  }

  export interface ModelFacts {
    [key: string]: unknown;
  }

  export interface WorldHost {
    pushEvent(
      e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { origin?: EventOrigin; blobs?: unknown[] },
      opts?: PushOptions,
    ): Promise<EventEnvelope>;
    store: EventStoreReader;
    modelFacts: ModelFacts;
    log: Logger;
  }

  export interface WorldLamp {
    label: string;
    state: 'online' | 'offline' | 'loading' | 'error';
    hint?: string;
  }

  export interface WorldPanelDecl {
    id: string;
    title: string;
    description?: string;
    getMethods?: readonly string[];
  }

  export interface WorldWebUiDecl {
    label?: string;
    lamps?: WorldLamp[];
    badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
    panels?: WorldPanelDecl[];
    invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
    config?: import('cortico/core/config-schema.ts').ConfigGroup[];
  }

  export interface ToolSchema {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    };
  }

  export interface ToolDef extends ToolSchema {
    tags: readonly ToolTag[];
    barrierAfter?: boolean;
    endsTurn?: boolean;
    interruptible?: boolean;
    handler: (args: Record<string, unknown>, ctx: unknown) => Promise<string | unknown>;
  }

  export interface World {
    id: string;
    envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>;
    tools(): ToolDef[];
    webUi?(language?: import('cortico/core/language.ts').Language): WorldWebUiDecl;
    start(host: WorldHost): Promise<void>;
    stop(): Promise<void>;
  }
}

declare module 'cortico/web/shared/client-panel.ts' {
  export interface WebUi {
    sheet(opts: { title: string; desc?: string }): { el: HTMLElement; body: HTMLElement };
    rowbar(): HTMLElement;
    h(tag: string): HTMLElement;
    chip(text: string, tone?: string): HTMLElement;
    kv(rows: Array<{ k: string; v: string }>): HTMLElement;
    [key: string]: unknown;
  }
  export interface WebUiPanelContext {
    root: HTMLElement;
    language: string;
    ui: WebUi;
    invoke<T>(method: string, args?: unknown[]): Promise<T>;
    interval(fn: () => void, ms: number): void;
  }
  export interface WebUiPanel {
    mount(ctx: WebUiPanelContext): Promise<void>;
  }
  export interface WebUiClientBundle {
    panels: Record<string, WebUiPanel>;
  }
}

declare module 'cortico/world.ts' {
  export type WorldSection = Record<string, unknown>;
  /** One string, or a zh/en pair the WebUI language picks from. */
  export type DescribeText = string | { zh: string; en: string };
  /** One tool as the market shows it: the model-facing schema plus a human-facing summary. */
  export interface ToolDescribe {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[]; [key: string]: unknown };
    tags: readonly string[];
    summary?: DescribeText;
  }
  /** One event this World pushes, for the market and the docs. */
  export interface EventDescribe {
    type: string;
    description: DescribeText;
    trigger?: string;
    tags?: readonly import('cortico/core/types.ts').EventTag[];
  }
  /** What `pnpm describe:extension` writes into the pack's describe.json. */
  export interface WorldDescribe {
    tools: readonly ToolDescribe[];
    events: readonly EventDescribe[];
  }
  export interface WorldContext<S extends WorldSection = WorldSection> {
    readonly id: string;
    readonly cfg: S;
    readonly timezone: string;
    readonly botName: string;
    readonly botDir: string;
    readonly packageDir: string;
    readonly dataDir: string;
    readonly repoRoot: string;
    secret(name: string): string;
    storeSecret(name: string, value: string): void;
    persist(patch: Partial<S>): void;
    restart(): Promise<void>;
  }
  export interface WorldDefinition<S extends WorldSection = WorldSection> {
    id: string;
    label: string;
    defaults(): S;
    preflight?(ctx: WorldContext<S>): void;
    configOptions?(kind: string, language: import('cortico/core/language.ts').Language): Array<{ value: string; label: string }>;
    /** The self-description the market reads instead of running the pack's code. */
    describe?: WorldDescribe;
    create(ctx: WorldContext<S>): import('cortico/core/types.ts').World;
  }
}
