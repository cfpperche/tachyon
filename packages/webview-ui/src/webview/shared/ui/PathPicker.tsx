/**
 * 514 — a file picker that works in a sidebar's width.
 *
 * The first version was a flat list of archives a scan had found. It could not do the one thing a file
 * picker exists for: reach a file the scan did not find. This one browses.
 *
 * ## What the references agree on, and what each part answers
 *
 * - **Breadcrumb** — "where am I", and one click back up the hierarchy. Every segment is a button;
 *   in a narrow rail only the tail segments fit, so the head collapses to `…` rather than wrapping.
 * - **Type to filter, type to navigate** — one input does both, because in a narrow column two would
 *   cost a row each. Text filters the current directory; a string that starts with `/` or `~` is a
 *   PATH and navigating to it is what Enter does.
 * - **Suggestions before browsing** — the first screen is not the filesystem root but the archives
 *   already found nearby, which is the "recent files" idea: the file someone wants is usually one
 *   they just built or downloaded.
 * - **Keyboard first** — ↑↓ move, Enter enters a folder or takes a file, Backspace at an empty filter
 *   goes up, Escape closes. A visible focus ring on the active row, never colour alone.
 *
 * Directories are listed before files, both alphabetical.
 *
 * The two truncations point in OPPOSITE directions, and that is the point rather than an inconsistency.
 * A NAME truncates at the end, because its head says which plugin it is (`agent-browser…` beats
 * `…-3.2.0.zip`). A PATH truncates at the head, because its tail says which folder it is
 * (`…goat/tachyon/dist` beats `/home/goat/tach…`) — which is why `.pp-where` is `direction: rtl`, and
 * why its content is wrapped in an LTR isolate so that RTL box does not migrate the leading slash to
 * the end. That last part was on screen from 514 until the 515 screenshots caught it.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { breadcrumbSegments, looksLikePath } from "./pathPickerModel";

export interface PathPickerEntry {
  name: string;
  path: string;
  kind: "dir" | "zip";
}

export interface PathPickerListing {
  dir: string;
  parent?: string;
  entries: PathPickerEntry[];
  error?: string;
}

export interface PathPickerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  /** The nearby archives shown before any browsing happens. */
  suggestions: PathPickerEntry[];
  /** The directory currently listed, or undefined while the suggestions are showing. */
  listing?: PathPickerListing;
  /** Ask the host to list a directory. */
  onBrowse: (dir: string) => void;
  onClose: () => void;
  onSelect: (filePath: string) => void;
  "data-testid"?: string;
}

/**
 * Isolate a path as left-to-right inside a right-to-left box.
 *
 * `.pp-where` is `direction: rtl` so the ellipsis eats the HEAD of a long path and its tail — the part
 * that distinguishes two folders — survives. The cost is bidi: `/` is a neutral character, so in an RTL
 * paragraph the leading slash migrates to the end and `/home/goat/Downloads` renders as
 * `home/goat/Downloads/`. Measured in the 515 screenshots; it had been on screen since 514.
 *
 * U+2066/U+2069 (LTR ISOLATE / POP DIRECTIONAL ISOLATE) fix the run's direction without touching the
 * BOX's direction, so the slashes stay put and the ellipsis still lands at the head.
 */
function ltr(value: string): string {
  return `\u2066${value}\u2069`;
}

function matches(entry: PathPickerEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length === 0 || entry.name.toLowerCase().includes(q);
}

export function PathPicker({
  open,
  title,
  subtitle,
  suggestions,
  listing,
  onBrowse,
  onClose,
  onSelect,
  "data-testid": testId,
}: PathPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Browsing resets the cursor and the filter: the filter belonged to the directory you left.
  useEffect(() => { setActive(0); setQuery(""); }, [listing?.dir]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const rows = useMemo<PathPickerEntry[]>(() => {
    const source = listing ? listing.entries : suggestions;
    return source.filter((entry) => matches(entry, query));
  }, [listing, suggestions, query]);

  useEffect(() => {
    if (active >= rows.length) setActive(rows.length > 0 ? rows.length - 1 : 0);
  }, [rows.length, active]);

  if (!open) return null;

  const take = (entry: PathPickerEntry): void => {
    if (entry.kind === "dir") onBrowse(entry.path);
    else onSelect(entry.path);
  };
  const goUp = (): void => {
    if (listing?.parent) onBrowse(listing.parent);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0))); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
    if (event.key === "Backspace" && query.length === 0) { event.preventDefault(); goUp(); return; }
    if (event.key !== "Enter") return;
    event.preventDefault();
    // A typed path wins over the highlighted row: someone who wrote an address means the address.
    if (looksLikePath(query)) { onBrowse(query.trim()); return; }
    const entry = rows[active];
    if (entry) take(entry);
  };

  const crumbs = listing ? breadcrumbSegments(listing.dir) : [];
  const shownCrumbs = crumbs.length > 4 ? crumbs.slice(crumbs.length - 4) : crumbs;

  return (
    <div class="pp-scrim" data-testid={testId} onClick={onClose}>
      <div class="pp-panel" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div class="pp-head">
          <div class="pp-title">{title}</div>
          {subtitle ? <div class="pp-subtitle">{subtitle}</div> : null}
        </div>

        {listing ? (
          <div class="pp-crumbs" data-testid="path-picker-crumbs">
            {crumbs.length > shownCrumbs.length ? <span class="pp-crumb-more">…</span> : null}
            {shownCrumbs.map((crumb, index) => (
              <span key={crumb.path}>
                {/* The root crumb IS a slash, so a separator after it reads as `/ / home`. Measured in
                    the 515 shots, where the breadcrumb bar rendered exactly that. */}
                {index > 0 && shownCrumbs[index - 1]!.path !== "/" ? <span class="pp-crumb-sep">/</span> : null}
                <button type="button" class="pp-crumb" onClick={() => onBrowse(crumb.path)}>{crumb.label}</button>
              </span>
            ))}
          </div>
        ) : null}

        <input
          ref={inputRef}
          class="pp-input"
          type="text"
          data-testid="path-picker-input"
          placeholder={listing ? "Filter, or type a path" : "Type a path to browse"}
          value={query}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setActive(0); }}
          onKeyDown={(e) => onKey(e as unknown as KeyboardEvent)}
        />

        <div class="pp-list" ref={listRef} role="listbox" aria-label={listing ? listing.dir : "Nearby archives"}>
          {listing?.parent ? (
            <button type="button" class="pp-row pp-up" onClick={goUp}>
              <Icon name="arrow-up" /><span class="pp-name">..</span>
            </button>
          ) : null}
          {rows.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              class={`pp-row${index === active ? " is-active" : ""}`}
              data-testid={`path-picker-row-${entry.name}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => take(entry)}
            >
              <Icon name={entry.kind === "dir" ? "folder" : "file-zip"} />
              <span class="pp-name">{entry.name}</span>
              {/* Where it is matters in the suggestions view, where rows come from four different roots. */}
              {!listing ? <span class="pp-where">{ltr(entry.path.slice(0, entry.path.length - entry.name.length - 1))}</span> : null}
            </button>
          ))}
          {rows.length === 0 ? (
            <div class="pp-empty">
              {listing?.error
                ? `Cannot read this folder: ${listing.error}`
                : listing
                  ? "No folders or .zip archives here."
                  : "No archives found nearby — type a path to browse."}
            </div>
          ) : null}
        </div>

        <div class="pp-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>⏎</kbd> open</span>
          <span><kbd>⌫</kbd> up</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
