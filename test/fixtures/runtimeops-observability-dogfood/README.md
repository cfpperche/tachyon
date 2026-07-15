# RuntimeOps observability dogfood fixture (SDD 369)

This is the isolated workspace opened by the existing **Tachyon: Dev Host** F5 profile. The fixture never autostarts
an agent, grants provider access, or installs a VSIX.

The coordinator arms the monorepo-local pointer before handoff. From the monorepo VS Code window:

1. Run and Debug → select **Tachyon: Dev Host**.
2. Press **F5** once.
3. Drive only the window titled `[Extension Development Host]`.
4. Follow `docs/specs/369-runtimeops-observability-v2/tasks.md` under **Human dogfood**.

`codex-observer` and `claude-observer` are intentionally manual. Enable the matching Runtime Ops source before starting
an observer, and do not send an inference prompt merely to obtain provider-account quota. VS Code may retain a prior
Extension Host `globalState`; begin by disabling both sources if either one is already enabled.

To inspect the pointer without launching anything, run from the monorepo:

```bash
npm run dogfood:dev-host -- point-status
```

After the live verdict is recorded and the EDH window is closed, cleanup is coordinated separately with
`npm run dogfood:dev-host -- point-clear`.
