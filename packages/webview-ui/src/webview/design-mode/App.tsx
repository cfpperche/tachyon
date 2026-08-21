import { Badge, Button, PageChrome } from "../shared/ui";
import type { DesignModeAction, DesignModeModel, DesignModeStrings } from "./messages";

export function App({ model, strings: s, post }: { model?: DesignModeModel; strings: DesignModeStrings; post: (action: DesignModeAction) => void }) {
  if (!model) return <main class="ds-page" data-testid="design-mode-app" />;
  if (!model.enabled) {
    return <main class="ds-page" data-testid="design-mode-app" data-state="gate-off">
      <PageChrome title={s.title} hint={s.hint} />
      <section class="dm-card">
        <Badge>{s.off}</Badge>
        <h2>{s.disabledTitle}</h2>
        <p>{s.disabledBody}</p>
        <Button variant="primary" onClick={() => post({ type: "openSettings" })}>{s.openSettings}</Button>
      </section>
    </main>;
  }
  const on = model.designModeOn;
  return <main class="ds-page" data-testid="design-mode-app" data-state={on ? "armed" : "disarmed"}>
    <PageChrome title={s.title} hint={s.hint} />
    <section class={`dm-card ${on ? "is-on" : ""}`}>
      <div class="dm-state">
        <div>
          <span class="dm-eyebrow">{s.title}</span>
          <h2>{on ? s.armed : s.disarmed}</h2>
        </div>
        <Badge tone={on ? "warn" : "default"}>{on ? s.on : s.off}</Badge>
      </div>
      <p>{on
        ? s.armedBody : s.disarmedBody}</p>
      <div class="dm-actions">
        <Button icon="globe" onClick={() => post({ type: "openBrowser" })}>{model.running ? s.revealBrowser : s.openBrowser}</Button>
        <Button variant={on ? "danger" : "primary"} icon="inspect" onClick={() => post({ type: "setDesignMode", on: !on })}>
          {on ? s.disarm : s.arm}
        </Button>
      </div>
    </section>
  </main>;
}
