/**
 * Hand-written fake of the Chrome extension API surface the real pages, packages and the in-page
 * background use (dev-only gallery; never bundled into the extension). The gallery's Vite config
 * aliases `wxt/browser` to this module, and importing it installs the same object as
 * `globalThis.chrome` and `globalThis.browser`, so every app module sees the fake whatever the
 * import order.
 *
 * Every call is recorded in `gallery.calls` (also `window.__gallery`). State that a scenario
 * configures (tabs, grants, the permission prompt's answer) lives in `gallery`.
 */

declare const __SV_GALLERY_MANIFEST__: GalleryManifest;

interface GalleryManifest {
  name: string;
  version: string;
  description?: string;
  permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  host_permissions?: string[];
  action?: { default_title?: string };
  commands?: Record<string, { description?: string; suggested_key?: { default?: string } }>;
}

type Fn<A extends unknown[]> = (...args: A) => unknown;

/** chrome.events.Event: listeners are called in registration order. */
function event<A extends unknown[]>() {
  const listeners = new Set<Fn<A>>();
  return {
    addListener: (l: Fn<A>) => void listeners.add(l),
    removeListener: (l: Fn<A>) => void listeners.delete(l),
    hasListener: (l: Fn<A>) => listeners.has(l),
    hasListeners: () => listeners.size > 0,
    listeners,
    emit: (...args: A) => {
      for (const l of [...listeners]) l(...args);
    },
  };
}

/** What crosses an extension message or storage boundary is serialised in Chrome. */
const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
const json = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

export interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  url?: string;
  title?: string;
  status: 'loading' | 'complete';
  active: boolean;
  incognito: boolean;
  /** A StudyVault content script is running in this tab (registered or injected). */
  contentScript: boolean;
}

export interface GalleryCall {
  api: string;
  args: unknown[];
  at: number;
}

type ContentScript = (tab: FakeTab, message: unknown) => Promise<unknown>;

export const RUNTIME_ID = 'studyvaultgalleryfakeextensionid';
/** The tab an extension page "is" (tabs.getCurrent): dashboard, review, options, tour. */
export const PAGE_TAB_ID = 900;
export const WINDOW_ID = 1;

export const gallery = {
  calls: [] as GalleryCall[],
  tabs: [] as FakeTab[],
  /** Origin patterns and API permissions Chrome currently grants (optional ones). */
  grantedOrigins: new Set<string>(),
  grantedPermissions: new Set<string>(),
  /** How Chrome's permission prompt answers `permissions.request`. */
  permissionPrompt: 'grant' as 'grant' | 'deny',
  registeredScripts: [] as { id: string; matches?: string[]; excludeMatches?: string[] }[],
  contentScript: null as ContentScript | null,
  manifest: __SV_GALLERY_MANIFEST__,
};

const record = (api: string, args: unknown[]) => {
  gallery.calls.push({ api, args: json(args), at: Date.now() });
};

// ---------------------------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------------------------

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;
const storageChanged = event<[StorageChanges, string]>();

function storageArea(area: 'local' | 'session' | 'sync' | 'managed') {
  const data = new Map<string, unknown>();
  const onChanged = event<[StorageChanges]>();
  const notify = (changes: StorageChanges) => {
    if (Object.keys(changes).length === 0) return;
    // Chrome delivers change events after the write resolved, asynchronously.
    setTimeout(() => {
      onChanged.emit(clone(changes));
      storageChanged.emit(clone(changes), area);
    }, 0);
  };
  const select = (keys?: null | string | string[] | Record<string, unknown>) => {
    if (keys === undefined || keys === null) return Object.fromEntries(data);
    if (typeof keys === 'string') return data.has(keys) ? { [keys]: data.get(keys) } : {};
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    }
    return Object.fromEntries(
      Object.entries(keys).map(([k, fallback]) => [k, data.has(k) ? data.get(k) : fallback]),
    );
  };
  return {
    async get(keys?: null | string | string[] | Record<string, unknown>) {
      return clone(select(keys));
    },
    async set(items: Record<string, unknown>) {
      const changes: StorageChanges = {};
      for (const [key, value] of Object.entries(items)) {
        const oldValue = data.get(key);
        const newValue = clone(value);
        data.set(key, newValue);
        // Chrome does not fire for a value that did not change.
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes[key] = oldValue === undefined ? { newValue } : { oldValue, newValue };
        }
      }
      notify(changes);
    },
    async remove(keys: string | string[]) {
      const changes: StorageChanges = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (data.has(key)) changes[key] = { oldValue: data.get(key) };
        data.delete(key);
      }
      notify(changes);
    },
    async clear() {
      const changes: StorageChanges = {};
      for (const [key, oldValue] of data) changes[key] = { oldValue };
      data.clear();
      notify(changes);
    },
    getBytesInUse: async () => JSON.stringify(Object.fromEntries(data)).length,
    setAccessLevel: async (_options: unknown) => undefined,
    onChanged,
  };
}

// ---------------------------------------------------------------------------------------------
// runtime messaging (same-page bus: the gallery backend lives in the page that calls it)
// ---------------------------------------------------------------------------------------------

type MessageSender = { id: string; url: string; origin: string };
type OnMessage = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response?: unknown) => void,
) => unknown;
const onMessage = event<Parameters<OnMessage>>();

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

/** Promise semantics of chrome.runtime.sendMessage, matching packages/runtime/src/messaging.ts. */
function dispatch(message: unknown, sender: MessageSender): Promise<unknown> {
  return new Promise((resolve, reject) => {
    queueMicrotask(() => {
      const wire = json(message);
      let done = false;
      let waiting = 0;
      const reply = (response?: unknown) => {
        if (done) return;
        done = true;
        resolve(json(response));
      };
      for (const listener of [...onMessage.listeners]) {
        const result = (listener as OnMessage)(wire, sender, reply);
        if (result === true) waiting++;
        else if (result instanceof Promise) {
          waiting++;
          result.then(reply, reject);
        }
      }
      if (!done && waiting === 0) reject(new Error(NO_RECEIVER));
    });
  });
}

/** Extension paths map onto the gallery pages: getURL('/review.html?x') -> <origin>/pages/review.html?x */
function getURL(path: string): string {
  return `${location.origin}/pages/${path.replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------------------------
// tabs / windows
// ---------------------------------------------------------------------------------------------

type TabChange = Partial<Pick<FakeTab, 'url' | 'title' | 'status'>>;
const tabsOnUpdated = event<[number, TabChange, ReturnType<typeof publicTab>]>();
const tabsOnActivated = event<[{ tabId: number; windowId: number }]>();
const tabsOnCreated = event<[ReturnType<typeof publicTab>]>();
const tabsOnRemoved = event<[number, { windowId: number; isWindowClosing: boolean }]>();

function publicTab(tab: FakeTab) {
  const { contentScript: _hidden, ...rest } = tab;
  return clone(rest);
}

/** Chrome's tabs.query url filter: match patterns with `*`, compared against the whole address. */
function urlMatches(pattern: string | string[], url: string | undefined): boolean {
  if (url === undefined) return false;
  return (Array.isArray(pattern) ? pattern : [pattern]).some((p) => {
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(url);
  });
}

function findTab(tabId: number): FakeTab {
  const tab = gallery.tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`No tab with id: ${tabId}.`);
  return tab;
}

let nextTabId = 1000;

export function addTab(tab: Partial<FakeTab> & { url?: string }): FakeTab {
  const full: FakeTab = {
    id: tab.id ?? nextTabId++,
    windowId: WINDOW_ID,
    index: gallery.tabs.length,
    status: 'complete',
    active: false,
    incognito: false,
    contentScript: false,
    ...tab,
  };
  if (full.active) for (const t of gallery.tabs) t.active = false;
  gallery.tabs.push(full);
  return full;
}

// ---------------------------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------------------------

const ALL_SITES = new Set(['<all_urls>', '*://*/*']);

function originCovered(requested: string): boolean {
  if (gallery.grantedOrigins.has(requested)) return true;
  for (const granted of gallery.grantedOrigins) {
    if (ALL_SITES.has(granted)) return true;
    const scheme = /^(https?):\/\/\*\/\*$/.exec(granted)?.[1];
    if (scheme && requested.startsWith(`${scheme}://`)) return true;
  }
  return false;
}

type PermissionSet = { origins?: string[]; permissions?: string[] };
const permissionsOnAdded = event<[PermissionSet]>();
const permissionsOnRemoved = event<[PermissionSet]>();

// ---------------------------------------------------------------------------------------------
// the browser object
// ---------------------------------------------------------------------------------------------

const manifest = gallery.manifest;
const local = storageArea('local');
const session = storageArea('session');

export const browser = {
  runtime: {
    id: RUNTIME_ID,
    lastError: undefined as { message: string } | undefined,
    getURL,
    getManifest: () => clone(manifest),
    getPlatformInfo: async () => ({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' }),
    sendMessage(message: unknown) {
      record('runtime.sendMessage', [message]);
      return dispatch(message, { id: RUNTIME_ID, url: location.href, origin: location.origin });
    },
    onMessage,
    onInstalled: event<[{ reason: string }]>(),
    onStartup: event<[]>(),
    async openOptionsPage() {
      record('runtime.openOptionsPage', []);
    },
    reload: () => record('runtime.reload', []),
  },

  storage: { local, session, sync: storageArea('sync'), onChanged: storageChanged },

  tabs: {
    async query(info: { active?: boolean; currentWindow?: boolean; url?: string | string[] }) {
      return gallery.tabs
        .filter((t) => info.active === undefined || t.active === info.active)
        .filter((t) => info.url === undefined || urlMatches(info.url, t.url))
        .map(publicTab);
    },
    async get(tabId: number) {
      return publicTab(findTab(tabId));
    },
    async getCurrent() {
      return publicTab(
        gallery.tabs.find((t) => t.id === PAGE_TAB_ID) ??
          addTab({ id: PAGE_TAB_ID, url: location.href, title: document.title }),
      );
    },
    async create(props: { url?: string; active?: boolean; windowId?: number }) {
      record('tabs.create', [props]);
      console.info('[gallery] tabs.create', props.url);
      // Opened tabs never take over the scenario's active tab, so the page under test keeps its context.
      const tab = addTab({ url: props.url, title: props.url, active: false });
      tabsOnCreated.emit(publicTab(tab));
      return publicTab(tab);
    },
    async update(tabId: number, props: { url?: string; active?: boolean }) {
      record('tabs.update', [tabId, props]);
      const tab = findTab(tabId);
      const change: TabChange = {};
      if (props.url !== undefined) tab.url = change.url = props.url;
      tabsOnUpdated.emit(tabId, change, publicTab(tab));
      return publicTab(tab);
    },
    async remove(tabIds: number | number[]) {
      record('tabs.remove', [tabIds]);
      for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        findTab(id);
        gallery.tabs = gallery.tabs.filter((t) => t.id !== id);
        tabsOnRemoved.emit(id, { windowId: WINDOW_ID, isWindowClosing: false });
      }
    },
    async sendMessage(tabId: number, message: unknown) {
      record('tabs.sendMessage', [tabId, message]);
      await Promise.resolve();
      const tab = gallery.tabs.find((t) => t.id === tabId);
      if (!tab?.contentScript || !gallery.contentScript) throw new Error(NO_RECEIVER);
      return json(await gallery.contentScript(tab, json(message)));
    },
    onUpdated: tabsOnUpdated,
    onActivated: tabsOnActivated,
    onCreated: tabsOnCreated,
    onRemoved: tabsOnRemoved,
  },

  windows: {
    WINDOW_ID_CURRENT: -2,
    async getCurrent() {
      return { id: WINDOW_ID, focused: true, incognito: false, type: 'normal', state: 'normal' };
    },
    async get(windowId: number) {
      return { id: windowId, focused: true, incognito: false, type: 'normal', state: 'normal' };
    },
    async getAll() {
      return [{ id: WINDOW_ID, focused: true, incognito: false, type: 'normal' }];
    },
    async update(windowId: number, props: Record<string, unknown>) {
      record('windows.update', [windowId, props]);
      return { id: windowId, focused: true, incognito: false };
    },
    onFocusChanged: event<[number]>(),
  },

  permissions: {
    async contains(set: PermissionSet) {
      return (
        (set.origins ?? []).every(originCovered) &&
        (set.permissions ?? []).every(
          (p) => gallery.grantedPermissions.has(p) || (manifest.permissions ?? []).includes(p),
        )
      );
    },
    async getAll() {
      return {
        origins: [...gallery.grantedOrigins],
        permissions: [...(manifest.permissions ?? []), ...gallery.grantedPermissions],
      };
    },
    async request(set: PermissionSet) {
      record('permissions.request', [set]);
      if (gallery.permissionPrompt === 'deny') return false;
      for (const o of set.origins ?? []) gallery.grantedOrigins.add(o);
      for (const p of set.permissions ?? []) gallery.grantedPermissions.add(p);
      setTimeout(() => permissionsOnAdded.emit(clone(set)), 0);
      return true;
    },
    async remove(set: PermissionSet) {
      record('permissions.remove', [set]);
      for (const o of set.origins ?? []) gallery.grantedOrigins.delete(o);
      for (const p of set.permissions ?? []) gallery.grantedPermissions.delete(p);
      setTimeout(() => permissionsOnRemoved.emit(clone(set)), 0);
      return true;
    },
    onAdded: permissionsOnAdded,
    onRemoved: permissionsOnRemoved,
  },

  scripting: {
    async getRegisteredContentScripts(filter?: { ids?: string[] }) {
      return clone(
        gallery.registeredScripts.filter((s) => !filter?.ids || filter.ids.includes(s.id)),
      );
    },
    async registerContentScripts(scripts: { id: string; matches?: string[] }[]) {
      record('scripting.registerContentScripts', [scripts]);
      gallery.registeredScripts.push(...clone(scripts));
    },
    async updateContentScripts(scripts: { id: string; matches?: string[] }[]) {
      record('scripting.updateContentScripts', [scripts]);
      for (const s of scripts) {
        const i = gallery.registeredScripts.findIndex((r) => r.id === s.id);
        if (i >= 0) gallery.registeredScripts[i] = { ...gallery.registeredScripts[i], ...clone(s) };
      }
    },
    async unregisterContentScripts(filter?: { ids?: string[] }) {
      record('scripting.unregisterContentScripts', [filter]);
      gallery.registeredScripts = gallery.registeredScripts.filter(
        (s) => filter?.ids && !filter.ids.includes(s.id),
      );
    },
    /** Injecting the highlighter starts the gallery's fake content script in that tab. */
    async executeScript(injection: { target: { tabId: number } }) {
      record('scripting.executeScript', [injection]);
      const tab = findTab(injection.target.tabId);
      if (!tab.url || !/^https?:/.test(tab.url)) {
        throw new Error(`Cannot access contents of url "${tab.url ?? ''}".`);
      }
      tab.contentScript = true;
      return [{ frameId: 0, documentId: 'gallery', result: undefined }];
    },
    insertCSS: async (_injection: unknown) => undefined,
  },

  sidePanel: {
    async open(options: { tabId?: number; windowId?: number }) {
      record('sidePanel.open', [options]);
    },
    setOptions: async (options: unknown) => void record('sidePanel.setOptions', [options]),
    getOptions: async () => ({ enabled: true, path: 'sidepanel.html' }),
    setPanelBehavior: async (behavior: unknown) =>
      void record('sidePanel.setPanelBehavior', [behavior]),
  },

  action: {
    setBadgeText: async (details: unknown) => void record('action.setBadgeText', [details]),
    setBadgeBackgroundColor: async (details: unknown) =>
      void record('action.setBadgeBackgroundColor', [details]),
    setTitle: async (details: unknown) => void record('action.setTitle', [details]),
    getBadgeText: async (_details: unknown) => '',
    getTitle: async (_details: unknown) => manifest.action?.default_title ?? manifest.name,
    getBadgeBackgroundColor: async (_details: unknown) => [0, 0, 0, 0],
    onClicked: event<[unknown]>(),
  },

  contextMenus: {
    create(item: unknown, callback?: () => void) {
      record('contextMenus.create', [item]);
      if (callback) setTimeout(callback, 0);
      return (item as { id?: string }).id ?? '';
    },
    update: async (id: unknown, props: unknown) => void record('contextMenus.update', [id, props]),
    remove: async (id: unknown) => void record('contextMenus.remove', [id]),
    removeAll: async () => void record('contextMenus.removeAll', []),
    onClicked: event<[unknown, unknown]>(),
  },

  commands: {
    /** Chrome lists the manifest commands with their current keys, plus the action command. */
    async getAll() {
      return [
        { name: '_execute_action', description: '', shortcut: '' },
        ...Object.entries(manifest.commands ?? {}).map(([name, c]) => ({
          name,
          description: c.description ?? '',
          shortcut: c.suggested_key?.default ?? '',
        })),
      ];
    },
    onCommand: event<[string, unknown]>(),
  },

  alarms: {
    create: async (name: unknown, info: unknown) => void record('alarms.create', [name, info]),
    get: async (_name: string) => undefined,
    getAll: async () => [],
    clear: async (name: unknown) => (record('alarms.clear', [name]), true),
    clearAll: async () => (record('alarms.clearAll', []), true),
    onAlarm: event<[{ name: string }]>(),
  },

  identity: {
    getRedirectURL: (path = '') => `https://${RUNTIME_ID}.chromiumapp.org/${path}`,
    async launchWebAuthFlow(details: unknown) {
      record('identity.launchWebAuthFlow', [details]);
      throw new Error('Sign-in windows are not available in the screen gallery.');
    },
  },

  extension: { inIncognitoContext: false },
  i18n: { getUILanguage: () => navigator.language || 'en' },
};

export type FakeBrowser = typeof browser;

const g = globalThis as unknown as Record<string, unknown>;
for (const name of ['chrome', 'browser'] as const) {
  Object.defineProperty(g, name, { value: browser, configurable: true, writable: true });
}
g.__gallery = gallery;
