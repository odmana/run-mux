# run-mux

Run your dev stack from a daemon, not a terminal tab.

`run-mux` runs **playbooks** — named sets of commands — against a git checkout. It keeps them alive
after you close the window, understands git worktrees well enough to run the same stack twice
without a port fight, and exposes everything over a structured CLI so an agent can drive it.

Extracted from [agent-mux](https://github.com/) 's playbook feature, minus the terminal multiplexer.

```
rmux                                  # the TUI
rmux start orders/main                # or just drive it from the shell
rmux logs orders/main --follow --json # or let an agent drive it
```

## Install

`rmux` is a single self-contained executable — the runtime is compiled in, so there is nothing to
install alongside it. Build it with [Bun](https://bun.sh) (version in `.bun-version`):

```
pnpm install
pnpm build      # dist/rmux, for this machine
pnpm build:all  # windows-x64, linux-x64, linux-arm64, darwin-x64, darwin-arm64
```

Expect 70–135 MB per binary depending on platform. Bun's runtime is nearly all of that, and there
is no way to leave it out.

## Why

Running a dev stack usually means three terminal tabs, and losing them all when the window closes.
Tools in this space (`foreman`, `overmind`, `mprocs`) run processes from a file in the foreground.
run-mux differs in four ways:

- **It's a daemon.** Processes outlive the UI. Close the terminal; the stack keeps running.
- **It knows about worktrees.** Run `main` and a feature branch side by side, on ports that don't
  collide, without editing a config.
- **It's cross-repo.** One view over every project you've registered, not one file per directory.
- **It's scriptable.** `--json` on every verb, so an agent can start a build, go away, and come
  back to ask what failed.

## Concepts

| Term | Meaning |
|---|---|
| **Repo** | A registered git repository. |
| **Checkout** | Its main worktree, or a linked one. run-mux discovers these; it never creates or removes them. |
| **Playbook** | A named set of commands. Lives in the repo (committed) or in your global config. |
| **Target** | A `(checkout, playbook)` pair you've created — one row in the sidebar. |
| **Run** | One execution of a target, with its own log file. |

A target is addressed by slug — `orders/main:run-orders` — or by any unambiguous prefix, so
`rmux start orders/main` usually does.

## Playbooks

Commit a `.run-mux.json` at your repo root:

```json
{
  "playbooks": [
    {
      "name": "Run Orders",
      "commands": [
        { "label": "Build", "type": "task", "command": "dotnet build" },
        { "label": "DataStore", "command": "cd src/Orders.DataStore && dotnet run", "dependsOn": ["Build"] },
        { "label": "Service", "command": "cd src/Orders.Service && dotnet run", "dependsOn": ["Build"] },
        { "label": "Web", "command": "cd src/Orders.Web && dotnet run", "dependsOn": ["Build"] }
      ]
    }
  ]
}
```

**Two kinds of command**, and the distinction does real work:

- **`task`** — must exit 0. Gates anything that `dependsOn` it. If it fails, its dependents don't
  start; unrelated commands keep running.
- **`service`** (the default) — runs indefinitely. Restarts on failure with backoff. Never cascades.

`dependsOn` gates on exit code 0, so it may only name a `task`. Naming a `service` is a config
error, caught at load — otherwise the dependent would wait forever for something that never exits.

## Worktrees and ports

Every checkout gets a stable **slot**. The main worktree is always slot `0`, so `main` runs on
exactly the ports your repo already expects. Each additional worktree gets 1, 2, 3… scoped per
repo, and the number never changes once assigned.

Commands receive it as an environment variable:

```jsonc
{ "label": "Web", "command": "ASPNETCORE_URLS=http://localhost:$((5000 + MUX_SLOT * 10)) dotnet run" }
```

| Variable | |
|---|---|
| `MUX_SLOT` | Stable per-checkout integer, `0` for main |
| `MUX_IS_MAIN` | `1` for the main worktree |
| `MUX_REPO`, `MUX_REPO_NAME` | Repo path, repo directory name |
| `MUX_CHECKOUT`, `MUX_BRANCH` | Checkout path, current branch |
| `MUX_TARGET`, `MUX_PLAYBOOK` | Target slug, playbook name |

## Commands

```
rmux                                  # TUI
rmux ls [--json]                      # targets and status
rmux add | rm <target>                # create/remove a target
rmux autostart <target> [--off]       # start this target with the daemon
rmux repo add <path> [--as <name>]    # register a repo under a short name
rmux repo ls | rm <path>
rmux start | stop | restart <target>
rmux restart <target> --command Web   # restart one command, not the stack
rmux logs <target> [--follow] [--label Web] [--since 5m] [--tail 200] [--json]
rmux status <target> [--json]
rmux env <target>                     # resolved environment, with the source of each variable
rmux config resolve <target>          # effective playbook, and where it came from
rmux config edit                      # open the global config in $EDITOR, then reload
rmux reload                           # re-read config (no file watching by design)
rmux daemon status | stop | restart
```

## Configuration

Two files, two jobs:

- **`<repo>/.run-mux.json`** — committed. Playbook definitions. Each worktree carries its own copy,
  so a branch can change its own dev commands.
- **`%APPDATA%/run-mux/config.json`** (or `~/.config/run-mux/config.json`) — yours, uncommitted.
  Registered repos, target overrides, secrets, and playbooks you'd rather not commit. Edit it with
  `rmux config edit`, which validates and reloads when you close the editor.

Repos are keyed by the short name you address them by, and that key is the first segment of every
target slug — so registering `orders` gives you `orders/main:run-orders`:

```json
{
  "repos": {
    "orders": {
      "path": "~/code/TicketSolutions.Orders",
      "playbooks": [{ "name": "Run Orders", "commands": [{ "label": "Web", "command": "dotnet run" }] }]
    }
  },
  "targets": {
    "orders/feat-x:run-orders": { "env": { "ASPNETCORE_HTTP_PORTS": "5010" } }
  }
}
```

A playbook here with the same name as one in the repo's `.run-mux.json` **replaces** it wholesale —
no merging. Run `rmux config resolve <target>` to see which one won.

Environment precedence, lowest to highest:

```
daemon env  <  playbook env  <  envFile  <  global target env  <  MUX_*
```

`rmux env <target>` prints the resolved set and attributes every variable to its layer.

## For agents

`--json` is a stable contract:

- stdout carries **only** JSON; diagnostics go to stderr.
- Streaming verbs emit one object per line.
- Every object carries `{"v": 1}`. Fields get added within a version, never removed or retyped.
- Errors emit a structured object **and** set a non-zero exit code.

`rmux logs <target> --follow --json` is the streaming primitive. It's resumable via `--since` and
guarantees no gap between a `start` and a later `--follow`, because logs are written to disk as
they arrive.

## Notes

Processes are **daemon-scoped**. A clean shutdown kills them; after an unclean one, the next daemon
start reaps the orphans. run-mux deliberately never re-adopts a process it didn't spawn — it can't
attach to that process's stdout, so it would run blind.

There's no config file watching. `rmux reload` is explicit, and a target already running keeps the
definition it started with until you restart it.

## Development

```
pnpm install
pnpm check        # lint, format, typecheck, build, test
pnpm test
pnpm dev ls       # run from source, no build
```

Bun is the runtime, the bundler and the test runner. pnpm keeps the install job because it alone
fetches OpenTUI's native core for every platform, which is what lets one machine cross-compile
every release binary.

Tests drive mock commands in `test/fixtures/`, never real applications. See `CLAUDE.md` for the
module layout and conventions.
