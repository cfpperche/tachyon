import { useState } from "preact/hooks";
import { Badge, Button, EmptyState, Input, PageChrome } from "../shared/ui";
import type { KeysAction, KeysModel, StoredKey } from "./messages";

/**
 * t-3b8073 — an unused key is not a mistake and the screen must not read like one.
 *
 * A machine key is machine-local BY DESIGN: it outlives the workspace it was added for. On
 * 2026-08-21 a workspace was destroyed and re-cloned, three provider keys correctly survived, and
 * this screen said "No profile declares this key" three times — a true sentence that named neither
 * the cause nor a way out, for credentials that were the reason the workspace existed.
 */
function keyStatusLine(key: StoredKey): string {
  if (key.usedBy.length) return `Used by ${key.usedBy.join(" · ")}`;
  if (key.orphan === "no-declarations") {
    return "Kept on this machine, declared by nothing here — no agent in this workspace declares any key. "
      + "Machine keys outlive the workspace they were added for, so a re-created workspace leaves them behind.";
  }
  return "No agent in this workspace declares this key — other keys here are declared.";
}

export function App({ model, post }: { model?: KeysModel; post: (action: KeysAction) => void }) {
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("");
  const [id, setId] = useState("");
  const [value, setValue] = useState("");
  const [menu, setMenu] = useState<string>();
  const [remove, setRemove] = useState<{ provider: string; id: string; usedBy: string[] }>();
  const stored = model?.stored ?? [];
  const missing = model?.missing ?? [];
  const providers = [...new Set(stored.map(key => key.provider))];
  const submit = (replace: boolean) => {
    if (!provider || !id || !value) return;
    post({ type: replace ? "replaceKey" : "storeKey", provider, id, value });
    setValue(""); setAdding(false); setMenu(undefined);
  };
  return <main class="ds-page keys-root">
    <PageChrome
      title="Keys"
      hint="Credentials for this machine. Never leave it."
      actions={<><span class="keys-count">{stored.length} stored · {missing.length} missing</span><Button variant="primary" onClick={() => setAdding(true)}>Add key</Button></>}
    />
    {adding && <section class="keys-form" aria-label="Add machine key">
      <div class="keys-form-title">Store a machine credential</div>
      <p class="keys-muted">The current value is never displayed. Replacing a key requires a new value.</p>
      <label>Provider<Input value={provider} placeholder="anthropic" onInput={e => setProvider((e.currentTarget as HTMLInputElement).value)} /></label>
      <label>Key id<Input value={id} placeholder="api-key" onInput={e => setId((e.currentTarget as HTMLInputElement).value)} /></label>
      <label>New value<Input type="password" value={value} placeholder="Enter a value" onInput={e => setValue((e.currentTarget as HTMLInputElement).value)} /></label>
      <div class="keys-actions"><Button variant="primary" onClick={() => submit(stored.some(k => k.provider === provider && k.id === id))}>Store key</Button><Button onClick={() => { setAdding(false); setValue(""); }}>Cancel</Button></div>
    </section>}
    <div class="keys-list">
      {stored.length === 0 && missing.length === 0 && <EmptyState message="No machine keys are configured." />}
      {providers.map(provider => <section key={provider}><h2>{provider}</h2>{stored.filter(key => key.provider === provider).map(key => <article class="keys-card" key={`${key.provider}/${key.id}`}>
        <div class="keys-row"><code>{key.provider}/{key.id}</code><Badge>{key.usedBy.length ? "in use" : key.orphan === "no-declarations" ? "orphaned" : "unused"}</Badge><button class="keys-menu" aria-label={`Actions for ${key.provider}/${key.id}`} onClick={() => setMenu(menu === key.id ? undefined : key.id)}>⋯</button></div>
        <div class="keys-muted">{keyStatusLine(key)}</div>
        {key.orphan && <div class="keys-actions"><Button onClick={() => post({ type: "declareKey", provider: key.provider, id: key.id })}>Declare in an agent</Button><Button variant="danger" onClick={() => setRemove(key)}>Remove key</Button></div>}
        {menu === key.id && <div class="keys-popover"><Button onClick={() => { setProvider(key.provider); setId(key.id); setAdding(true); setMenu(undefined); }}>Replace value</Button><Button variant="danger" onClick={() => { setRemove(key); setMenu(undefined); }}>Remove</Button></div>}
      </article>)}</section>)}
      {missing.length > 0 && <section><h2>Missing</h2>{missing.map(key => <article class="keys-card" key={`${key.agent}/${key.provider}/${key.id}`}>
        <div class="keys-row"><code>{key.provider} / {key.id}</code><Badge>declared</Badge><Button onClick={() => { setProvider(key.provider); setId(key.id); setAdding(true); }}>Store</Button></div>
        <div class="keys-muted">Required by <strong>{key.agent}</strong> — cannot launch without it</div>
      </article>)}</section>}
    </div>
    {remove && <div class="keys-confirm" role="dialog" aria-label="Confirm key removal"><h2>Remove {remove.provider}/{remove.id}?</h2><p>This cannot be undone. {remove.usedBy.length ? `It will prevent ${remove.usedBy.join(" and ")} from launching until stored again.` : "No saved agent currently declares this key."}</p><div class="keys-actions"><Button onClick={() => setRemove(undefined)}>Cancel</Button><Button variant="danger" onClick={() => { post({ type: "removeKey", provider: remove.provider, id: remove.id }); setRemove(undefined); }}>Remove</Button></div></div>}
    <footer class="keys-storage">Stored in <code>secrets.json</code> on this machine, owner-only.</footer>
  </main>;
}
