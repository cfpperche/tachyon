# 227 — tachyon-harness-env-file — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Implementation — DONE 2026-06-16
- [x] `parseEnvFile(text)` in HarnessManager — plain/quoted/`export `/`#`/blank/malformed. Pure.
- [x] `HarnessManager.readEnvFile()` reads `<workspaceRoot>/.env`; resolution = `procEnv[name] ?? envFile[name]`.
- [x] missing-var error now names `.env` ("in the project .env or your shell").
- [x] Example: researcher comment → `.env`; added `.env.example` + `.env` to the example `.gitignore`.
      README (repo) + site harness section: "from a project `.env` (or your shell)".

## Tests — DONE (559 unit + typecheck + build green)
- [x] `parseEnvFile` value forms.
- [x] materialize resolves a ref from `<ws>/.env` when NOT in procEnv.
- [x] `process.env` wins over `.env` on conflict (dotenv precedence).
- [x] missing in BOTH → fail-closed `HarnessUnavailableError` naming `.env`.

## Follow pass (out of scope)
- configurable env-file path; VS Code SecretStorage (prompt-once).
