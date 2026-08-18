# run-mux

A daemon-backed CLI that runs *playbooks* — named sets of commands — against a git checkout
(the main worktree or a linked one). Extracted from agent-mux's playbook feature.

## Shape

```
src/types.ts       shared contracts. Every module implements against this. Do not edit casually.
src/roles.ts       the argv roles, and how the binary tells compiled from development
src/version.ts     the only reader of package.json; the build folds the version in with --define
src/paths.ts       every on-disk location. Honours RUN_MUX_HOME so tests stay off real user dirs.
src/config/        global + per-repo config, validation, playbook precedence, env layering
src/git/           worktree enumeration (read-only — run-mux never creates or removes one)
src/state/         state file, slot allocation, target registry
src/supervisor/    process supervision: tasks, services, dependsOn, restart, tree kill
src/logs/          JSONL run store, retention, in-memory tail, queries
src/ipc/           NDJSON over named pipe / unix socket, autospawn
src/daemon/        command layer + daemon assembly
src/cli/           argument parsing, human and --json output
src/tui/           OpenTUI renderer, in its own process with its own daemon connection
scripts/build.ts   compiles the release binaries — this host, or all five targets with --all
test/fixtures/     mock commands — tests never invoke real apps
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
- **TUI view state goes through the daemon.** Sidebar width, folded groups and the
  sidebar's display order live in `state.ui`, written through `ui.get` / `ui.set`. The TUI is a
  second process and `saveState` rewrites the whole file, so a direct write would land on top of
  whatever the supervisor recorded in between. The order is a *view* layer, never a permutation of
  `state.targets`: `rmux ls` and `--json` answer in registration order and must keep doing so.
- **The renderer runs with `autoFocus: false`.** Every key goes through the one handler in
  `app.ts`. Turn it back on and a click focuses the sidebar's scroll box, whose own bindings
  include `j`/`k`, so each selection move would scroll it too. For the same reason the sidebar's
  glyphs are `selectable: false` — a press on selectable text starts a text selection and the
  drag events never reach the reorder handlers.
- **The main column clips; the log pane must not.** OpenTUI's hit grid drops the bottom row of
  any box with `overflow: hidden`, so a clipping log pane leaves its newest line unclickable and
  impossible to start a drag-selection on. The clip belongs on the column around it, where the row
  it costs is the footer. `y` yanks a live selection ahead of the buffer, so that row matters.
- **The log pane is virtual, so its scrollbar is drawn rather than real.** React state only ever
  holds the rows on screen, which leaves nothing for an OpenTUI `ScrollBox` to measure a thumb
  against: `thumb()` and `jumpTo()` in `logpane.ts` map the buffer's matching-line count onto the
  gutter instead. A real ScrollBox would mean one renderable per retained line — the shape
  `log-buffer.ts` exists to avoid.
- **One binary, three roles.** `rmux <verb>` is the CLI, `rmux __daemon` the daemon, `rmux __tui`
  the TUI. A compiled executable has no scripts on disk, so the CLI re-execs *itself* with a role
  argument rather than resolving an entry path. Never reintroduce a path-based lookup:
  `src/roles.ts` is the only place that decides, and `RUN_MUX_DAEMON_ENTRY` / `RUN_MUX_TUI_ENTRY`
  are the seam tests substitute stubs through.

## Tooling

- **Bun is the runtime, the bundler and the test runner**, pinned in `.bun-version`. No Node, no
  `fnm`.
- **pnpm still installs**, and the reason is not taste: `bun install` has no equivalent of pnpm's
  `supportedArchitectures`, which is what fetches OpenTUI's native core for every platform so one
  host can cross-compile every release binary. Never `npx`.
- Exact versions in package.json — no `^` or `~`.
- `pnpm check` runs lint, format check, typecheck, build and tests. `pnpm lint:fix` and `pnpm fmt`
  auto-fix. Typecheck alone is `pnpm typecheck`.
- `pnpm build` compiles `dist/rmux` for this host; `pnpm build:all` cross-compiles all five targets.
  A binary is 70–135 MB depending on platform — Bun's runtime is nearly all of it. `--bytecode` is
  deliberately not used: it cannot compile top-level await, which OpenTUI's chunks rely on.

## Testing

Tests use the mock commands in `test/fixtures/`, never real applications. `test/helpers.ts` gives
you `ticker()`, `service()`, `spawner()`, `envDump()`, `chatty()` to build portable command
strings, plus `useTempHome()`, `makeGitRepo()`, `addWorktree()`, `waitFor()` and `isAlive()`.

Never sleep a fixed duration to wait for a process — use `waitFor()`. Process tests are
timing-sensitive, and they rely on `bun test` running files serially in one process; they can
still flake under heavy load, so re-run before assuming a change broke them.

The 20s timeout is passed on the command line, in the `test` script. It has to be: Bun ignores
`[test] timeout` in bunfig.toml, and a preload calling `jest.setTimeout()` only reaches the first
test file.

## Style

Add a comment only when it carries real weight — a non-obvious "why", a gotcha, a business rule.
Never comment tests, and never restate what the code already says. One line is usually enough.
