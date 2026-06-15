/**
 * spec 218 — child env for real-tmux tests with `$TMUX`/`$TMUX_PANE` STRIPPED.
 *
 * The suite is run from a shell inside a Tachyon pane, so `$TMUX` points at the PRODUCTION
 * `-L tachyon` server. Any tmux invocation that omits `-L <socket>` targets the inherited
 * server — a single missed `-L` (spec 217's `anchor.integration` `kill-server`) killed every
 * live agent. With `$TMUX` unset, an unscoped tmux op falls back to the `default` socket, never
 * production. Every real-tmux test executor MUST run tmux with this env (in addition to
 * `-L <isolated socket>` scoping on the call itself — this is the second layer).
 */
export function tmuxChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}
