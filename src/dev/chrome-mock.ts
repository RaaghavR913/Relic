import type { PreviewScenario } from './mock-data';
import { MOCK_DOC, MOCK_FLAGS } from './mock-data';

type StorageArea = {
  get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
  clear: () => Promise<void>;
};

function makeStorage(initial: Record<string, unknown>): StorageArea {
  const data = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) out[k] = data[k];
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, fallback] of Object.entries(keys)) {
        out[k] = data[k] ?? fallback;
      }
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}

function seedForScenario(scenario: PreviewScenario): {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
} {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};

  if (scenario !== 'onboarding') {
    local['disclora:onboarded'] = true;
  }

  if (scenario === 'filing') {
    const hash = MOCK_DOC.rawTextHash;
    session['filing:current'] = { hash };
    session[`filing:model:${hash}`] = MOCK_DOC;
    session[`filing:flags:${hash}`] = MOCK_FLAGS;
  }

  return { local, session };
}

export function installChromeMock(scenario: PreviewScenario): void {
  const { local, session } = seedForScenario(scenario);
  const localStore = makeStorage(local);
  const sessionStore = makeStorage(session);
  const messageListeners = new Set<(msg: unknown) => void>();

  const chromeMock = {
    runtime: {
      getManifest: () => ({ version: '1.2.7', name: 'Disclora' }),
      getURL: (resource: string) =>
        resource === 'brand-logo.png' ? '/brand-logo.png' : `chrome-extension://mock/${resource}`,
      openOptionsPage: () => {
        window.open('/src/settings/index.html', '_blank', 'noopener,noreferrer');
      },
      sendMessage: async (msg: { type?: string }) => {
        if (msg?.type === 'ANALYZE_PAGE') return { ok: true };
        return undefined;
      },
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => messageListeners.add(fn),
        removeListener: (fn: (msg: unknown) => void) => messageListeners.delete(fn),
      },
    },
    storage: {
      local: localStore,
      session: sessionStore,
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async () => undefined,
    },
    permissions: {
      request: async () => true,
    },
  };

  (globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;
}
