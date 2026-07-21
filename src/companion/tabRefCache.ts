/**
 * SDD 420 — last-snapshot @e ref metadata per opaque tabId.
 * Used by safety gates so click/type/fill with only ref=@eN still sees
 * element name/href/selector from the most recent snapshot.
 */

export type CachedTabRef = {
  ref: string;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
  /** Optional href when the snapshot/outline provided it. */
  href?: string;
};

export class TabRefCache {
  private readonly byTab = new Map<string, Map<string, CachedTabRef>>();

  /** Replace cache for a tab from a successful snapshot result. */
  putFromSnapshot(tabId: string, refs: CachedTabRef[] | undefined): void {
    const id = tabId.trim();
    if (!id) return;
    const map = new Map<string, CachedTabRef>();
    for (const r of refs ?? []) {
      if (!r.ref?.trim()) continue;
      map.set(r.ref.trim(), {
        ref: r.ref.trim(),
        selector: r.selector,
        tag: r.tag,
        role: r.role,
        name: r.name,
        href: r.href,
      });
    }
    this.byTab.set(id, map);
  }

  lookup(tabId: string | undefined, ref: string | undefined): CachedTabRef | undefined {
    if (!tabId?.trim() || !ref?.trim()) return undefined;
    return this.byTab.get(tabId.trim())?.get(ref.trim());
  }

  /** Flatten hints for safety classification. */
  hintsFor(tabId: string | undefined, ref: string | undefined): {
    selector?: string;
    name?: string;
    href?: string;
    elementText?: string;
  } {
    const hit = this.lookup(tabId, ref);
    if (!hit) return {};
    return {
      selector: hit.selector,
      name: hit.name,
      href: hit.href,
      elementText: hit.name,
    };
  }

  clear(tabId?: string): void {
    if (tabId) this.byTab.delete(tabId.trim());
    else this.byTab.clear();
  }
}
