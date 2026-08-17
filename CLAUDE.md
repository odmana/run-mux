# run-mux

A daemon-backed CLI that runs *playbooks* — named sets of commands — against a git checkout
(the main worktree or a linked one). Extracted from agent-mux's playbook feature.

## Shape

```
src/types.ts       shared contracts. Every module implements against this. Do not edit casually.
src/paths.ts       every on-disk location. Honours RUN_MUX_HOME so tests stay off real user dirs.
src/config/        global + per-repo config, validation, playbook precedence, env layering
src/git/           worktree enumeration (read-only — run-mux never creates or removes one)
src/state/         state file, slot allocation, target registry
src/supervisor/    process supervision: tasks, services, dependsOn, restart, tree kill
src/logs/          JSONL run store, retention, in-memory tail, queries
src/ipc/           NDJSON over named pipe / unix socket, autospawn
src/daemon/        command layer + daemon assembly
src/cli/           argument parsing, human and --json output
test/fixtures/     mock commands (node scripts) — tests never invoke real apps
```

## Core rules

- **A `task` must exit 0 and gates its dependents; a `service` runs long and never cascades.**
  `dependsOn` gates on exit code 0 only. Depending on a `service` is a config validation error,
  because it would sit in `pending` forever.
- **Slots are per-repo and the main worktree is always 0**, so `main` keeps the ports the repo's
  own config already expects. Slots persist — a port that moves between runs is useless.
- **`--json` is an API.** stdout is pure JSON, diagnostics go to stderr, streams are one object
  per line, every object carries `{"v":1}`. Fields may be added within a version, never removed
  or retyped. No colour, no spinners under `--json`.
- **Processes are daemon-scoped.** Never re-adopt a process the daemon did not spawn — you cannot
  attach to its stdout, so it would run with a permanent hole in its logs.

## Tooling

- **`fnm` for node versions**, pinned in `.node-version`. `fnm use` in the repo root, or set up
  `eval "$(fnm env --use-on-cd --shell bash)"` to switch automatically.
- `pnpm` for everything, never `npx`.
- Exact versions in package.json — no `^` or `~`.
- **Node >= 26.1 is required**, because OpenTUI's renderer calls `node:ffi` and the TUI must be
  launched with `--experimental-ffi`. That flag does not exist on Node 22 or 24. The daemon and CLI
  themselves run fine on older Node; the floor comes from the TUI alone.
- `pnpm check` runs lint, format check, build and tests. `pnpm lint:fix` and `pnpm fmt` auto-fix.
- Typecheck without writing `dist/`: `pnpm exec tsc --noEmit`.

## Testing

Tests use the mock commands in `test/fixtures/`, never real applications. `test/helpers.ts` gives
you `ticker()`, `service()`, `spawner()`, `envDump()`, `chatty()` to build portable command
strings, plus `useTempHome()`, `makeGitRepo()`, `addWorktree()`, `waitFor()` and `isAlive()`.

Never sleep a fixed duration to wait for a process — use `waitFor()`. Process tests are
timing-sensitive and vitest is configured to run them in a single fork for that reason; they can
still flake under heavy load, so re-run before assuming a change broke them.

## Style

Add a comment only when it carries real weight — a non-obvious "why", a gotcha, a business rule.
Never comment tests, and never restate what the code already says. One line is usually enough.
