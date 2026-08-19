import { useState } from "preact/hooks";
import { Badge, Button, Input, PageChrome } from "../shared/ui";
import type { KeysAction, KeysModel } from "./messages";

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
    <PageChrome title="Keys" hint="Credentials for this machine. Never leave it." />
    <header class="keys-toolbar"><span>{stored.length} stored · {missing.length} missing</span><Button variant="primary" onClick={() => setAdding(true)}>Add key</Button></header>
    {adding && <section class="keys-form" aria-label="Add machine key">
      <div class="keys-form-title">Store a machine credential</div>
      <p class="keys-muted">The current value is never displayed. Replacing a key requires a new value.</p>
      <label>Provider<Input value={provider} placeholder="anthropic" onInput={e => setProvider((e.currentTarget as HTMLInputElement).value)} /></label>
      <label>Key id<Input value={id} placeholder="api-key" onInput={e => setId((e.currentTarget as HTMLInputElement).value)} /></label>
      <label>New value<Input type="password" value={value} placeholder="Enter a value" onInput={e => setValue((e.currentTarget as HTMLInputElement).value)} /></label>
      <div class="keys-actions"><Button variant="primary" onClick={() => submit(stored.some(k => k.provider === provider && k.id === id))}>Store key</Button><Button onClick={() => { setAdding(false); setValue(""); }}>Cancel</Button></div>
    </section>}
    <div class="keys-list">
      {stored.length === 0 && missing.length === 0 && <p class="keys-muted">No machine keys are configured.</p>}
      {providers.map(provider => <section key={provider}><h2>{provider}</h2>{stored.filter(key => key.provider === provider).map(key => <article class="keys-card" key={`${key.provider}/${key.id}`}>
        <div class="keys-row"><code>{key.provider}/{key.id}</code><Badge>{key.usedBy.length ? "in use" : "unused"}</Badge><button class="keys-menu" aria-label={`Actions for ${key.provider}/${key.id}`} onClick={() => setMenu(menu === key.id ? undefined : key.id)}>⋯</button></div>
        <div class="keys-muted">{key.usedBy.length ? `Used by ${key.usedBy.join(" · ")}` : "No profile declares this key"}</div>
        {menu === key.id && <div class="keys-popover"><Button onClick={() => { setProvider(key.provider); setId(key.id); setAdding(true); setMenu(undefined); }}>Replace value</Button><Button variant="danger" onClick={() => { setRemove(key); setMenu(undefined); }}>Remove</Button></div>}
      </article>)}</section>)}
      {missing.length > 0 && <section><h2>Missing</h2>{missing.map(key => <article class="keys-card" key={`${key.agent}/${key.provider}/${key.id}`}>
        <div class="keys-row"><code>{key.provider} / {key.id}</code><Badge>declared</Badge><Button onClick={() => { setProvider(key.provider); setId(key.id); setAdding(true); }}>Store</Button></div>
        <div class="keys-muted">Required by <strong>{key.agent}</strong> — cannot launch without it</div>
      </article>)}</section>}
    </div>
    {remove && <div class="keys-confirm" role="dialog" aria-label="Confirm key removal"><h2>Remove {remove.provider}/{remove.id}?</h2><p>This cannot be undone. {remove.usedBy.length ? `It will prevent ${remove.usedBy.join(" and ")} from launching until stored again.` : "No saved agent currently declares this key."}</p><div class="keys-actions"><Button onClick={() => setRemove(undefined)}>Cancel</Button><Button variant="danger" onClick={() => { post({ type: "removeKey", provider: remove.provider, id: remove.id }); setRemove(undefined); }}>Remove</Button></div></div>}
    <footer>Storage: <code>secrets.json</code>, machine-local, owner-only. Not a keychain.</footer>
  </main>;
}
