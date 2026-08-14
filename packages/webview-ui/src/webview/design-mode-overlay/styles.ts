export const OVERLAY_CSS = `
:host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;color-scheme:var(--ds-color-scheme);font:var(--ds-body)/1.4 var(--ds-font-ui)}
:host *, :host *::before, :host *::after{box-sizing:border-box}
button,textarea,select{font:inherit}
button,select{color:var(--ds-btn-fg);background:var(--ds-surface-raised);border:var(--ds-border-width) solid var(--ds-border)}
button:hover:not(:disabled){background:var(--ds-hover)}
button:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--ds-focus);outline-offset:1px}
button:disabled,select:disabled{opacity:var(--ds-disabled-opacity)}
textarea{color:var(--ds-input-fg);background:var(--ds-input-bg);border:var(--ds-border-width) solid var(--ds-border)}
[aria-pressed="true"],[data-testid="annotation-add"]:not(:disabled),[data-testid="annotation-send"]:not(:disabled){color:var(--ds-btn-fg)!important;background:var(--ds-btn-bg)!important;border-color:var(--ds-focus)!important}
[role="status"]{color:var(--ds-muted)}
[data-testid="markup-editor"]{background:var(--ds-editor-bg)!important}
[data-testid="markup-editor"] button{pointer-events:auto}
[data-testid="annotation-tray"] code{color:var(--ds-fg)!important}
[data-testid="annotation-tray"] small{color:var(--ds-info)!important}
[data-testid="annotation-tray"] article,[data-testid="annotation-tray"] header{border-color:var(--ds-separator)!important}
.tachyon-markup-active [data-testid="annotation-tray"],.tachyon-markup-active [data-testid="viewport-toolbar"],.tachyon-markup-active [data-testid^="annotation-badge-"]{display:none!important}
.tachyon-markup-active [data-testid="markup-editor"]{z-index:3!important}
`;
