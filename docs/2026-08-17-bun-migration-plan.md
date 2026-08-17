# Bun migration plan — one binary, no runtime

> **Executed, 17 August 2026.** All seven phases are complete and `pnpm check` is green: lint,
> format, typecheck, build, **288 pass / 1 skip / 0 fail**. §8 records what shipped and where this
> plan turned out to be wrong. The plan text below is left as written so the two can be compared.
>
> Goal: replace Node with Bun across run-mux, with the primary aim of shipping `rmux` as a
> **single self-contained executable**. Every claim marked ✓ below was measured before the plan was
> written — on this machine (Windows 11 10.0.26200, x64, bun 1.3.14, node 26.7.0) and, for the POSIX
> claims, in Docker on a WSL2 Linux kernel (`oven/bun:1.3.14` A/B against `node:26-slim`).

**Verdict: GO.** Both Phase 0 gates — the two risks that could have killed this — are now **cleared
by measurement**, not by argument. OpenTUI's full production render path works inside a compiled
binary on a real Windows console, and `src/supervisor/kill.ts`'s POSIX process-group path is
verified behaviour-equivalent to Node on Linux with **no change to `kill.ts` required**.

The migration is a net **deletion** of code: the `--experimental-ffi` dance, the Node 26.1 floor,
and three copies of "read package.json to find my own version" all go away.

Two things drive the plan's shape:

1. A compiled binary has no `dist/daemon/index.js` to point a runtime at, so **autospawn must
   re-exec the binary itself** (§3).
2. **Bun reports `process.version` as `v24.3.0`**, so every Node-version gate in the tree misfires.
   Removing them is a *prerequisite* for the TUI running at all under Bun, not late cleanup (§4.3).

---

## 1. What was measured

| # | Question | Result |
|---|---|---|
| 1 | Does `node:net` named-pipe IPC work on Bun/Windows? | ✓ listen, connect, round-trip all fine |
| 2 | Can a compiled binary spawn a detached copy of itself with `stdio: ['ignore', fd, fd]`? | ✓ full autospawn round-trip through a named pipe |
| 3 | Does OpenTUI's native Zig lib load under Bun? | ✓ `bun:ffi`, no flags |
| 4 | Does it still load **inside `bun build --compile`**? | ✓ Bun embeds `opentui.dll`, dlopens from bunfs |
| 5 | Can one host cross-compile every target? | ✓ linux-x64, darwin-arm64, windows-x64 from Windows |
| 6 | Does the existing test suite run on `bun test`? | ✓ see §1.3 |
| 7 | `node:readline` + `createReadStream` (the log query path)? | ✓ identical to Node |
| 8 | Startup cost vs Node? | ✓ 121–140 ms warm vs node's 139 ms |
| 9 | **Does the real TUI render in a compiled binary?** | ✓ **Phase 0a cleared — §1.2** |
| 10 | **Does POSIX group-kill behave like Node under Bun?** | ✓ **Phase 0b cleared — §1.3** |

### 1.1 Findings that shape the plan

**Finding A — `process.argv[1]` is a virtual path in a compiled binary.** It reads
`B:/~BUN/root/entry.ts`, not a real file; `process.argv[0]` is the literal string `"bun"`.
`process.argv.slice(2)` is still correct, so `parseArgs` is unaffected — but three "am I the entry
module?" checks and three `packageRoot()` walks silently break. See §4.4 and §4.5.

**Finding B — `process.version` is `v24.3.0` under Bun.** Any Node-version gate misfires. In
particular `ffiAvailable()` (`src/tui/index.ts:59-82`) probes for `node:ffi`, which Bun does not have
(it uses `bun:ffi`), so the **unmodified `runTui()` refuses outright with exit 69** under Bun. This
is why §4.3 moves ahead of the rest.

**Finding C — Bun does not produce Node-shaped bind errors (Windows only).** A second listen on a
busy named pipe gives `Failed to listen at \\.\pipe\...` with **no `.code`**, where Node gives an
`errno`-carrying error that `describeBindError` (`src/ipc/server.ts:320`) maps to a friendly
`conflict`. This was the single failure out of 162 tests on Windows. On Linux the whole `ipc` suite
passes 27/0 under Bun, because the unix-socket path goes through `clearStaleSocket` instead — so
this is a **Windows-specific** divergence.

**Finding D — cross-compilation hinges on pnpm, not on Bun.** OpenTUI resolves its native core via
`@opentui/core-${target.platform}` optional deps. Bun's bundler picks the right branch per
`--target`, but the package has to be **on disk**. `pnpm` supplies them from one host:

```yaml
# pnpm-workspace.yaml
supportedArchitectures:
  os: [win32, linux, darwin]
  cpu: [x64, arm64]
  libc: [glibc, musl]
```

Verified: this pulls all 8 `@opentui/core-*` platform packages, after which cross-compiling to
linux-x64, darwin-arm64 and windows-x64 all succeed from this Windows box. **This is why the plan
keeps pnpm as the package manager** and uses Bun only as runtime, bundler and test runner — `bun
install` has no `supportedArchitectures` equivalent, and losing it would force a CI matrix with one
runner per OS.

**Finding E — top-level `await` semantics differ, in Bun's favour here.** Bun keeps the process
alive while a top-level `await` is pending; Node prints `Detected unsettled top-level await` and
exits 13. Because every timer in `killTrees` is unref'd, **Node can abandon a kill mid-flight in a
bare-script context** — it did, in 3 of 4 probe runs, and never once under Bun. In the real daemon
and CLI a ref'd handle holds the loop open under both, so run-mux's behaviour is unchanged. Nothing
to fix. The mirror-image risk was checked and is clear: a dangling never-settling promise (like
`kill.ts`'s `softFailed`, which never resolves on POSIX) does not hold either runtime open. But
carry the general caveat: **a top-level `await` on something that can never settle hangs Bun
forever**, where Node warns and exits.

### 1.2 Phase 0a — the TUI in a compiled binary: **CLEARED**

Every named risk was exercised inside a `bun build --compile` binary, escalating in fidelity, each
A/B'd against the same probe uncompiled. No probe failed at any level, so there was never a
compiled-vs-uncompiled discrepancy to attribute.

- **Renderer + React reconciler.** `@opentui/react`'s `testRender` builds a genuine `CliRenderer`, so
  the Zig-backed buffer, yoga layout, stdin parser and hit-tester all really run. run-mux's **real
  `App`**, compiled, produced a frame **byte-identical** to uncompiled — borders, status glyphs
  (`● ◌ ◑ ✖ ⊗`), chips, ANSI-coloured log lines, footer. Real SGR-1006 bytes hit-tested to correct
  element-local coordinates, i.e. the offset bug that disqualified Ink is still absent under Bun.
- **The production path, on a real console.** `createCliRenderer({ exitOnCtrlC: false, useMouse:
  true, targetFps: 30 })` + `createRoot(renderer).render(createElement(App, …))` — byte-for-byte what
  `runTui()` does past its guard — ran compiled on a real 116×32 Windows console: raw mode genuinely
  enabled, `renderer.stdin === process.stdin`, `j` moved the selection, `:` opened the palette, `ESC`
  closed it, an SGR click hit-tested correctly, alt-screen and mouse teardown clean. It also works
  with piped stdout, falling back to 80×24 — **`createCliRenderer()` does not require a TTY.**
- **Real IPC.** Compiled binary → node-hosted `tui-daemon.mjs` over a Windows named pipe: 6 targets
  listed, 6000 log lines flooded with **nothing dropped** and the pane virtualizing (614 ms),
  wheel-scroll, resize 120×30 → 80×24 → 120×30, palette → form → fuzzy picker round-tripping
  `repo.list` over the socket.
- **Workers + tree-sitter wasm.** `parser.worker.js` resolves out of bunfs, spawns, loads
  `tree-sitter.wasm` and per-language assets, and highlights identically to uncompiled. OpenTUI's
  bunfs support is real, not aspirational. **Separately, run-mux cannot reach this path at all**:
  `getTreeSitterClient()` has exactly one call site (`CodeRenderable`), and `src/tui/elements.ts`
  exposes only `box`, `text`, `scrollbox`. A non-risk today, and proven safe if a `<code>` pane is
  ever added.
- **Self-contained.** Compiled probes ran correctly from a directory with no `node_modules` and no
  repo source present.

### 1.3 Phase 0b — POSIX group-kill under Bun: **CLEARED**

A/B, same host and kernel, Linux Bun 1.3.14 vs Linux Node 26.7.0. A structural note that makes this
load-bearing: `sh -c "<runtime> script.mjs"` does **not** exec-replace on Linux, so the direct child
really is a shell, the runtime is its child, and the fixture's grandchild is one level below — the
exact 3-level shape `kill.ts`'s header comment describes.

| Behaviour | Result |
|---|---|
| `spawn(..., {detached:true})` makes a group leader | **Equivalent.** Both `setsid` (group *and* session leader); `detached:false` control discriminates |
| `process.kill(-pid, SIGTERM/SIGKILL)` | **Equivalent.** Reaches shell, runtime and grandchild. Non-leader negative pid throws `ESRCH` in both — no `kill(-1)`-style catastrophe |
| `process.kill(-pid, 0)` group-emptiness probe | **Equivalent**, including leader-dead-and-reaped-but-grandchild-alive → does not throw, poll continues. Only the message text differs, and `kill.ts` catches without inspecting it |
| SIGTERM → grace → SIGKILL escalation | **Equivalent.** Verbatim port of `kill.ts`: cooperative 52/51 ms, **stubborn grandchild while the shell dies** 1005/1004 ms, stubborn direct child 1005/1005 ms, 3 trees batched 1006/1011 ms |
| `child.unref()` / `setTimeout().unref()` | **Equivalent** across all four ref/unref combinations |

**Real suites under Linux Bun** (staged via `git archive HEAD`, working tree untouched, only the
`vitest` → `bun:test` import changed): `supervisor.test.ts` **21/21** (3× identical),
`daemon.test.ts` **27/27** including both orphan-reaping tests. Node + vitest baseline on the same
kernel: 48/48. Also 0 fail on state (26), logs (27), config (33), worktrees (12), ipc (27),
cli-args (16).

Beyond the repo's own coverage, a purpose-written suite drove the **real `Supervisor`** against a
grandchild that ignores SIGTERM — the case the repo's POSIX suite does not cover — asserting the
grandchild is dead the instant `stop()` resolves and that `stop()` does *not* resolve while the group
is still occupied: **3/3 under both** runtimes.

**Container caveat, identical in both runtimes:** a zombie still counts as a process-group member, so
if the daemon ever runs as **PID 1 with no reaper**, orphans are never reaped and every stop burns
`2 × KILL_GRACE_MS` while reporting the tree alive. `--init` fixes it. Not a Bun issue and not a
problem on a normal box, but worth knowing before anyone containerises the daemon.

### 1.4 Binary size — the one real cost

| Target | Size |
|---|---|
| darwin-arm64 | 70.5 MB |
| windows-x64 | 104.0 MB |
| linux-x64 | 135.2 MB |

`--minify --bytecode` did **not** move size (Bun's runtime dominates); it did improve warm start
(121 ms vs 140 ms), so still pass it. There is no way to get this meaningfully smaller — it is the
price of the goal. State it in the README rather than discovering it at release time.

Cold first-run on Windows measured **388 ms** against 140 ms warm — Defender scanning a ~100 MB
unsigned executable, not Bun. Code signing the Windows artefact belongs in the release story.

---

## 2. What does *not* change

- **`src/types.ts`, `src/protocol.ts`, the wire format.** Untouched.
- **`src/supervisor/kill.ts`.** Phase 0b verified it needs **no change**.
- **`src/paths.ts`, `src/config/`, `src/state/`, `src/logs/`, `src/git/`, `src/supervisor/`.** All
  verified by passing suites under Bun on both Windows and Linux.
- **valibot, oxlint, oxfmt.** Runtime-agnostic. `tsc --noEmit` stays as the typechecker; Bun does not
  typecheck.
- **The `--json` contract.** A compiled binary prints nothing of its own to stdout.
- **pnpm.** Stays, per Finding D.

---

## 3. The architectural change: one binary, three roles

Today three files are entry points, and two are located **as files on disk** and handed to
`process.execPath`:

- `src/cli/index.ts` — the CLI
- `src/daemon/index.ts` — spawned as `node dist/daemon/index.js` (`src/ipc/spawn.ts:109`)
- `src/tui/index.ts` — spawned as `node --experimental-ffi dist/tui/index.js` (`src/cli/commands/tui.ts:63`)

A compiled binary has no `dist/` and no script paths. The replacement is **argv role dispatch**:

```
rmux <verb> ...   → CLI          (as today)
rmux __daemon     → daemon       (hidden; what autospawn spawns)
rmux __tui        → TUI          (hidden; what a bare `rmux` spawns)
```

`ensureDaemon` then spawns `process.execPath` with `['__daemon']` instead of `[entry]` — exactly the
shape proven in measurement #2.

**Keep the three-process split; do not collapse the TUI in-process.** Bun removes the *original*
reason for the split (the `--experimental-ffi` flag), so collapsing is tempting. Resist it:

1. CLAUDE.md's rule — *"the CLI must start and answer `--version` without loading a line of daemon
   code"* — survives argv dispatch for free, because the role branch happens before any import.
2. The `RUN_MUX_DAEMON_ENTRY` / `RUN_MUX_TUI_ENTRY` seams that `test/cli.test.ts` and
   `test/tui.test.ts` depend on keep working, if reinterpreted rather than deleted:

```
RUN_MUX_DAEMON_ENTRY set  → spawn execPath + [thatScript]   (dev + tests, unchanged)
otherwise                 → spawn execPath + ['__daemon']    (compiled binary)
```

That single conditional is the migration's load-bearing change. Everything else in §4 is mechanical.

---

## 4. Phased work plan

Phase 0 is **complete** (§1.2, §1.3). The order below reflects Finding B: de-gating the TUI moved
ahead of the entry-point work, because until it lands the TUI does not run under Bun at all.

### Phase 1 — toolchain swap

- `pnpm-workspace.yaml`: add the `supportedArchitectures` block from Finding D.
- `package.json`: drop `tsx` and `vitest`; drop `esbuild` from `onlyBuiltDependencies` (it came in via
  those two); add `@types/bun`. Resolve the odd `"run-mux": "link:"` self-dependency while here.
- `tsconfig.json`: `"types": ["node"]` → `["bun", "node"]`. Leave `module`/`moduleResolution` on
  `NodeNext` — the `.js`-suffixed imports work as-is under Bun (verified), and changing it is churn
  with no payoff.
- Scripts: `dev` → `bun src/cli/index.ts`; `test` → `bun test`; `build` → see Phase 6.
- `.node-version` → `.bun-version`.

### Phase 2 — tests: vitest → `bun test`

Measured as near-free — 161/162 on Windows, and on Linux every suite that could be staged passed.

- All 9 `test/*.test.ts`: `from 'vitest'` → `from 'bun:test'`.
- `vi.spyOn` → `spyOn` (1 site), `vi.restoreAllMocks` → `jest.restoreAllMocks` (2 sites). That is the
  entire mocking surface in the suite.
- Delete `vitest.config.ts`. Its `pool: 'forks' / maxWorkers: 1 / fileParallelism: false` exists so
  process tests don't race — `bun test` runs files serially in one process by default, satisfying the
  same constraint. Carry `testTimeout: 20000` over as `[test] timeout = 20000` in `bunfig.toml`.
- **`src/ipc/server.ts:320` `describeBindError`** — widen to match Bun's message shape as well as
  Node's `EADDRINUSE`, per Finding C. This is a **product** fix, not a test fix: without it a wedged
  daemon on Windows reports a bare `Failed to listen at ...` instead of the `rmux daemon restart`
  hint.
- `test/cli.test.ts:59` spawns `process.execPath [TSX, CLI, ...]` — becomes `bun src/cli/index.ts`.
  (This suite was never evaluated under Bun; it was the one suite Phase 0b could not stage, for an
  unrelated `tsx`-packaging reason that this change removes.)
- Watch for state leakage: vitest forks each file, `bun test` does not. `useTempHome()` restores
  `RUN_MUX_HOME`, so it should hold.

### Phase 3 — drop the Node/FFI gates ***(moved up: prerequisite, not cleanup)***

Per Finding B, until this lands the TUI refuses to start under Bun with exit 69. Pure deletion, and
everything downstream of the guard is already proven by Phase 0a, so there is no discovery risk here.
Estimated ~30 minutes.

- `src/tui/index.ts:59-82` `ffiAvailable()` — the `node:ffi` probe, and the `refuse()` it triggers.
- `src/tui/index.ts:26-33` `silenceFfiWarning()` — `bun:ffi` emits no `ExperimentalWarning`.
- `src/cli/commands/tui.ts` — `FFI_FLAG`, `MIN_NODE_MAJOR/MINOR`, `meetsNodeFloor()`,
  `tooOldMessage()`, and the flag in the spawn at `:63`. ~40 lines.
- `src/cli/commands/tui.ts:30-37` — the `existsSync(entry)` "TUI is not built" guard, meaningless for
  an embedded role.
- `package.json` `engines.node`.
- `test/fixtures/fake-node-version.mjs` and the tests asserting the too-old-Node message.

**Milestone:** at the end of this phase `bun src/cli/index.ts` gives a working TUI in development,
with no compiled binary involved yet.

### Phase 4 — argv role dispatch

- `src/cli/index.ts`: branch on `process.argv[2]` for `__daemon` / `__tui` **before** `parseArgs`,
  dispatching via `await import()` so neither role's code loads for an ordinary verb.
- `src/ipc/spawn.ts:26-36` — `EnsureDaemonOptions.entry` becomes optional; add the role args.
  `spawnDaemon` (`:109`) spawns `execPath + ['__daemon']` when no entry override is set.
- `src/cli/commands/daemon.ts:52-59` — `daemonEntry()` / `tuiEntry()` become `daemonSpawn()` /
  `tuiSpawn()` returning `{ execPath, args }`, keeping the env-var override branch of §3.
- `src/daemon/index.ts:47-56` `runDirectly()` and `src/tui/index.ts:120-122` `invokedDirectly` — both
  compare `process.argv[1]` to `import.meta.url`, which Finding A breaks. Replace with an explicit
  role check.

### Phase 5 — version, once instead of three times

`cliVersion()` (`src/cli/commands/daemon.ts:61`), `packageVersion()` (`src/ipc/server.ts:363`) and
`version()` (`src/tui/index.ts:49`) all read `package.json` off disk and all silently return `'0.0.0'`
in a compiled binary — including in `daemon status` output and the IPC hello frame.

Replace all three with one `src/version.ts`:

```ts
export const VERSION = process.env.RUN_MUX_BUILD_VERSION ?? readPackageJsonOrFallback();
```

and pass `--define process.env.RUN_MUX_BUILD_VERSION='"0.1.0"'` at compile time. Works in dev (reads
package.json) and compiled (constant-folded), and collapses three implementations into one.

### Phase 6 — build and release

```
bun build src/cli/index.ts --compile --minify --bytecode \
  --define process.env.RUN_MUX_BUILD_VERSION='"0.1.0"' \
  --target=<target> --outfile dist/rmux-<target>
```

Targets: `bun-windows-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`
(+ `-musl` linux variants if Alpine matters). All buildable from one host after Phase 1.

Distribution changes shape: the product is a **release artefact on PATH**, not `npm i -g`. Decide
what `package.json`'s `"bin": "./dist/cli/index.js"` becomes — either a `#!/usr/bin/env bun` script
for contributors, or drop it and document the binary. Sign the Windows artefact (§1.4).

### Phase 7 — docs

CLAUDE.md **Tooling** (fnm, the Node >= 26.1 floor, the `--experimental-ffi` rationale) and
**Shape** sections; README install instructions; and a note that this plan superseded the
Node-runtime decision recorded in `docs/2026-08-17-tui-runtime-spike.md`, now historical on that
point.

---

## 5. Risk register

| Risk | Severity | Status |
|---|---|---|
| TUI fails to render in a compiled binary | ~~High~~ | **RETIRED** — §1.2, incl. real Windows console |
| POSIX group-kill diverges under Bun | ~~High~~ | **RETIRED** — §1.3, `kill.ts` needs no change |
| Windows bind-error shape differs (Finding C) | Low | Known; one-line fix in Phase 2 |
| 70–135 MB per-platform binaries | Medium | Accepted; unavoidable, document it |
| **macOS/BSD never tested** | Medium | **Open** — see §5.1 |
| Physical keystrokes/mouse from a real terminal emulator | Low-Medium | **Open** — see §5.1 |
| Windows cold start ~390 ms unsigned | Low | Mitigated by code signing |
| `bun test` sharing one process across files leaks state | Low | Watch during Phase 2 |
| Top-level `await` that never settles hangs Bun (Finding E) | Low | Style caveat; no current instance |
| Daemon as PID 1 in a container → `2 ×` grace on every stop | Low | Pre-existing, both runtimes; use `--init` |

### 5.1 What is still unproven

Honest list — none look like blockers, but none are verified:

- **macOS / BSD entirely.** Phase 0b ran on a Linux kernel in Docker. The `kill.ts` POSIX path is
  shared, and macOS `setsid`/`kill(-pgid)` semantics match Linux, but this is inference, not
  measurement. Same for musl/Alpine and non-container Linux.
- **Physical input from a terminal emulator.** Phase 0a injected bytes onto `process.stdin` rather
  than typing. It confirmed raw mode was really enabled on a real console handle and that OpenTUI
  binds the actual `process.stdin`, so what remains is a narrow Bun-vs-Node stdin-*delivery*
  question with no bunfs involvement. Verify by hand in Windows Terminal.
- **Terminal capability replies** (DA / XTVERSION) — reported identically with and without a TTY,
  which was not compared against Node. Look at it only if terminal detection matters.
- **Clipboard** (`src/tui/clipboard.ts`: OSC 52 + `spawn('clip.exe')`) and **SIGINT alt-screen
  teardown** in a compiled binary. Both plain `node:child_process`/signal work.
- **`cli.test.ts` under Bun** — the one suite neither Phase 0 agent could stage, for a `tsx`-
  packaging reason that Phase 2 removes anyway.
- **The daemon and CLI as compiled binaries.** Phase 0a assessed the TUI; measurement #2 proved the
  autospawn shape. The composed whole lands in Phase 6.

## 6. Recommended order

1 → 2 → 3 → 4 → 5 → 6 → 7, as numbered. Phases 1–3 leave the tree working on Bun *in development*
with no compiled binary at any point, and Phase 3 is the milestone where the TUI comes back to life.
Phases 4–5 make it compilable; Phase 6 compiles it. Every phase through 5 is independently
revertible.

Run the two open items in §5.1 that need hardware — a macOS check of `supervisor.test.ts`, and a
by-hand keystroke check in Windows Terminal — opportunistically alongside Phases 1–3, rather than
letting them gate the start.

---

## 8. Execution record

All seven phases landed. `pnpm check` green: lint, format, typecheck, build,
**288 pass / 1 skip / 0 fail** across 10 files.

### 8.1 Where the plan was wrong

Five corrections, all found by executing rather than by reasoning:

1. **There were *four* copies of the version logic, not three.** The plan named `cliVersion()`,
   `packageVersion()` (ipc) and `version()` (tui). It missed a fourth `packageVersion()` in
   `src/daemon/daemon.ts`. Nothing caught it until the compiled binary reported `version 0.1.0`
   for the CLI and `0.0.0` for the daemon **in the same process image**. `src/version.ts` is now
   provably the only reader of package.json in `src/`.
2. **`--bytecode` cannot be used at all.** It cannot compile top-level await, which OpenTUI's
   chunks use to resolve their native backend, so the build fails outright. The flag was in the
   plan's §4 build command. Dropped, with the reason recorded in `scripts/build.ts` — it was only
   ever worth ~15 ms of startup and no size at all.
3. **`[test] timeout` in `bunfig.toml` is silently ignored by Bun 1.3.14.** So is the obvious
   fallback: `preload` + `jest.setTimeout()` applies only to the *first* test file, because Bun
   resets the default to 5000 ms for each subsequent one. Only the `--timeout` CLI flag works, so
   the 20 s budget lives in the `test` script.
4. **Finding C understated the Windows bind divergence.** Bun's busy-pipe error is not merely
   "missing `.code`" — it is a `TypeError` carrying a *misleading* `code: 'ERR_INVALID_ARG_TYPE'`.
   Keying on an absent `.code` would not have worked. The reliable discriminator is `errno`: the
   busy case has none, while genuine listen failures carry `errno: 10050, syscall: 'listen'`.
5. **`process.execPath + [role]` is only correct once compiled.** In development `execPath` is the
   bun binary, so that spawn makes Bun hunt for a *file* named `__daemon`. `roleArgs()` in
   `src/roles.ts` names the entry script in development and omits it when compiled, discriminating
   on whether the entry sits under Bun's embedded filesystem (`/$bunfs/`, `~BUN`) — the same marker
   OpenTUI keys its own asset resolution off.

Phase 3 also moved ahead of Phases 4-5 during execution, per Finding B: until the Node gates were
deleted the TUI refused to start under Bun at all, so it was a prerequisite rather than cleanup.

### 8.2 What shipped

- **`src/roles.ts`** — the argv roles (`__daemon`, `__tui`), and the compiled-vs-development
  decision. One binary, three programs.
- **`src/version.ts`** — the only reader of package.json; the build folds the version in.
- **`scripts/build.ts`** — `pnpm build` for the host, `pnpm build:all` for five targets.
- **Deleted:** `vitest.config.ts`, `.node-version`, `test/fixtures/fake-node-version.mjs`,
  `runDirectly()`, `invokedDirectly`, `ffiAvailable()`, `silenceFfiWarning()`, `meetsNodeFloor()`,
  `tooOldMessage()`, three `packageRoot()` walks, four version readers, `engines.node`, the
  `bin` field, and every `--experimental-ffi` reference.

### 8.3 End-to-end verification of the compiled binary

Beyond the suite, the actual artefact was exercised:

- **Windows** — `dist/rmux.exe` autospawned its own daemon by re-execing itself, registered a real
  git repo, ran a playbook whose `task` gated a `service` via `dependsOn`, streamed logs, answered
  `--json`, and killed the service's process tree on stop (confirmed dead by pid).
- **Linux, cross-compiled from Windows** — `rmux-bun-linux-x64` ran on bare `debian:12-slim` with
  **no Bun, no Node and no node_modules present**: autospawn over a unix socket, `daemon status`,
  `daemon stop`.
- **POSIX supervision inside a compiled binary** — the combination neither Phase 0 gate covered on
  its own. In-container: the service was a genuine process-group leader (`PGID == PID`), its group
  held 3 processes, and **0 remained after `stop`**. No orphans.
- All five targets cross-compile from this one Windows host: darwin-arm64 70.5 MB,
  darwin-x64 75.9 MB, windows-x64 103.9 MB, linux-arm64 134.4 MB, linux-x64 135.1 MB.

### 8.4 Still open

Unchanged from §5.1, and none of it blocked the migration:

- **macOS/BSD never executed.** The darwin binaries build but have never been run. The POSIX path
  is shared with Linux, which is now verified twice over, but that is inference.
- **Physical keystrokes in a terminal emulator.** Phase 0a drove the real renderer on a real Windows
  console with raw mode genuinely enabled, but injected bytes rather than typing.
- **Clipboard** (OSC 52 + `clip.exe`) and **SIGINT alt-screen teardown** in a compiled binary.
- **Release plumbing.** There is no CI, no publish step and no code signing; `pnpm build:all` is the
  whole story today. Windows cold start on an unsigned ~100 MB binary measured ~390 ms against
  ~140 ms warm, so signing is worth doing when a release channel exists.
