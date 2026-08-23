/**
 * 514 slice F — what an installed app's page can store, measured rather than assumed.
 *
 * ## What the measurement found
 *
 * A webview HAS `localStorage`, and it is partitioned per ORIGIN. VS Code's own guidance is explicit
 * about what that means for an extension: *"All instances of a webview will now run on the same origin
 * so if they are using an API such as local storage, be sure to partition any data/state that is
 * document specific per resource"*.
 *
 * Every Tachyon app tab is created under ONE view type (`tachyonUserApp`, and it has to be — VS Code
 * cannot register a serializer for a type it learns about after activation). So every installed app
 * shares one origin, and therefore one `localStorage`. Two consequences, and neither was in the spec:
 *
 *  1. **One app can read and overwrite another app's data.** Not a sandbox escape — an installed app
 *     is trusted with the Bridge — but an accident waiting to happen between two apps that both
 *     store `"settings"`.
 *  2. **Uninstalling could not clear it.** No API hands an extension a webview's storage, so the
 *     directory went and whatever the page had written stayed, invisible and unowned.
 *
 * ## What this does about it
 *
 * The shim namespaces `localStorage` and `sessionStorage` per app, so each app gets its own keyspace
 * inside the shared origin without its author doing anything. That is what makes the data OWNED, and
 * ownership is what makes it removable: a page of the same origin can clear another app's prefix, so
 * every app page sweeps the prefixes of apps that no longer exist when it loads.
 *
 * The honest limit, stated because the confirmation dialog depends on it: an app's storage is cleared
 * the next time ANY app opens, not at the instant of uninstall. Nothing of ours runs in that origin
 * while no app tab is open, and opening a hidden tab to sweep would flash a panel at the human for a
 * housekeeping errand. A determined app can also still reach the raw store behind the namespace; this
 * partitions by convention enforced in the shim, and an installed app was already trusted.
 */

/** The key prefix that makes one app's storage its own inside the shared origin. */
export function appStoragePrefix(appId: string): string {
  return `tachyon.app.${appId}.`;
}

/**
 * The storage half of the page shim.
 *
 * Written as a string because it runs in the page, not here. It replaces the two Storage objects with
 * namespaced views and, before handing them over, drops every `tachyon.app.*` key whose app is not in
 * the installed list — which is the sweep that makes uninstall eventually total.
 */
export function storageShim(appId: string, installedIds: readonly string[]): string {
  return `
<script>
(() => {
  const PREFIX = ${JSON.stringify(appStoragePrefix(appId))};
  const INSTALLED = ${JSON.stringify(installedIds)};
  const owned = (key) => {
    const match = /^tachyon\\.app\\.([a-z0-9-]+)\\./.exec(key);
    return match ? match[1] : undefined;
  };
  const sweep = (store) => {
    try {
      const doomed = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        const app = key === null ? undefined : owned(key);
        if (app !== undefined && !INSTALLED.includes(app)) doomed.push(key);
      }
      for (const key of doomed) store.removeItem(key);
    } catch { /* a store we cannot read is a store we cannot sweep; not this page's problem */ }
  };
  const namespaced = (store) => ({
    get length() { let n = 0; for (let i = 0; i < store.length; i += 1) { const k = store.key(i); if (k && k.startsWith(PREFIX)) n += 1; } return n; },
    key(index) { let n = 0; for (let i = 0; i < store.length; i += 1) { const k = store.key(i); if (k && k.startsWith(PREFIX)) { if (n === index) return k.slice(PREFIX.length); n += 1; } } return null; },
    getItem(key) { return store.getItem(PREFIX + key); },
    setItem(key, value) { store.setItem(PREFIX + key, String(value)); },
    removeItem(key) { store.removeItem(PREFIX + key); },
    clear() {
      const doomed = [];
      for (let i = 0; i < store.length; i += 1) { const k = store.key(i); if (k && k.startsWith(PREFIX)) doomed.push(k); }
      for (const k of doomed) store.removeItem(k);
    },
  });
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const real = window[name];
      sweep(real);
      Object.defineProperty(window, name, { value: namespaced(real), configurable: true });
    } catch { /* the page keeps whatever it had; nothing here is worth breaking a page over */ }
  }
})();
</script>
`;
}
