/**
 * Just enough browser for the modules under test.
 *
 * These tests run in Node: the stores persist through `window.localStorage`, and
 * the URL state reads and replaces `window.location`. Full jsdom would be a
 * heavy answer to that — this is the whole of what they actually touch, and it
 * keeps the address bar inspectable from a test.
 */
const entries = new Map<string, string>();

const localStorage: Storage = {
  get length() {
    return entries.size;
  },
  key: (index) => [...entries.keys()][index] ?? null,
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => void entries.set(key, String(value)),
  removeItem: (key) => void entries.delete(key),
  clear: () => entries.clear(),
};

let url = new URL('https://rtl.test/');

globalThis.window = {
  localStorage,
  get location() {
    return url;
  },
  history: {
    state: null,
    replaceState: (_state: unknown, _title: string, next: string) => {
      url = new URL(next, url);
    },
  },
} as unknown as Window & typeof globalThis;

globalThis.localStorage = localStorage;
