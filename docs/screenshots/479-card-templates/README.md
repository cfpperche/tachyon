# SDD 479 — agent card previews

Rendered by `test/browser/cardPreviewShots.test.ts` from the real `AgentRow`
and the shipped `dist/webview/sidebar.css`. Regenerate with:

```sh
npm run build
npx vitest run --config vitest.browser.config.ts test/browser/cardPreviewShots.test.ts
```

- `default-320.png`
- `default-narrow-220.png`
- `configured-320.png`
- `configured-narrow-220.png`
- `auth-required-readmitted-320.png`
- `auth-required-readmitted-narrow-220.png`
- `refusal-320.png`
- `refusal-narrow-220.png`
- `terminal-unaffected-320.png`
- `terminal-unaffected-narrow-220.png`
