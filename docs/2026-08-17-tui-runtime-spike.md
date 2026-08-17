# M0 spike — OpenTUI on Node + Windows

> **Historical record, 17 August 2026.** This is the investigation that chose the TUI's rendering
> stack. It is kept for the reasoning, not as live documentation. The decision was taken: run-mux
> targets **upstream OpenTUI on Node >= 26.1 with `--experimental-ffi`**, pinned in `.node-version`.
> The spike tree has since been deleted; its one durable artefact — the SGR-1006 mouse byte builder
> — now lives at `test/fixtures/sgr.ts` and drives the TUI's mouse tests.
>
> Two findings below still bind the implementation: the log pane **must** coalesce and virtualize
> (the naive approach measurably collapses), and copy-out needs Shift-bypass plus an explicit copy
> verb, because mouse reporting suppresses native drag-select.

**Verdict: GO-WITH-CAVEATS.** The two risks M0 existed to retire are retired. Mouse hit-testing —
the thing that disqualified Ink — works completely (29/29 assertions, including a negative control
proving the harness can go red). Log streaming sustains **50,000 lines/s with flat memory**, 10x the
requirement. Do not build the hand-rolled renderer.

The caveats are all about *how you get OpenTUI onto Node*, not about whether it does the job:

1. **Upstream `@opentui/core` 0.5.3 cannot run on Node 22 or Node 24 at all.** It calls
   `node:ffi`, which only exists from **Node 26.1** and only behind `--experimental-ffi`. No
   published OpenTUI version has ever worked without it. run-mux pins Node 22.22.0 today.
2. **There are exactly two ways onto Node 22/24, and both carry risk.** Either move run-mux's floor
   to Node 26 + an experimental flag (Node 26 reaches Active LTS **2026-10-28**), or depend on
   `@jitl/opentui-*`, a **single-maintainer third-party fork** that works today on Node 22/24 with
   no flags — verified here, all harnesses pass unmodified — but is one minor behind upstream and
   has not published since **2026-06-30**.
3. **`node:ffi` is Stability 1 – Experimental with no announced unflag date**, and is actively
   churning (correctness bugs filed upstream as recently as today).
4. **Coalescing and windowing the log pane is mandatory, not an optimisation.** The naive approach
   loses 31% of lines and drops to 1 fps inside 30 seconds.
5. **Native terminal drag-select is suppressed while run-mux is in the foreground.** Shift bypasses
   it in Windows Terminal, conhost, Alacritty and WezTerm; OpenTUI also has its own selection API
   that yields usable text.

Everything below was measured on this machine: Windows 11 (10.0.26200), x64, `@opentui/core` and
`@opentui/react` 0.5.3, React 19.2.0. Raw output is in `spike/out/`.

---

## 1. Does it install and run at all on Node + Windows?

### Install: clean. Run: only on Node 26 with a flag.

The install itself is one of the better-behaved native packages I have seen:

- **29 packages, 2.9s, no postinstall of any kind.** OpenTUI runs no install scripts. The only
  ignored build script was `esbuild`, pulled in by `tsx` (a spike-only dev dependency).
- **No download or extraction at install time.** The native core ships as a normal npm optional
  dependency per platform (`@opentui/core-win32-x64`, `-darwin-arm64`, `-linux-x64-musl`, ...), the
  same pattern esbuild and swc use. On this box that resolved to a single **5.2 MB `opentui.dll`**,
  already on disk, integrity-checked by the lockfile. Nothing phones home.
- Licences for the vendored native pieces ship alongside it (Ghostty, libwebp, lcms2, stb, wuffs) —
  i.e. the Zig core vendors real C libraries, which is worth knowing but is disclosed.

**Footprint.** Runtime dependency closure is roughly **27 MB**: `@opentui/core` 14 MB,
`core-win32-x64` 5.1 MB, `web-tree-sitter` 4.7 MB, `react-reconciler` 1.7 MB, then `diff`,
`marked`, `react`, `@opentui/react`, `scheduler`. Note `web-tree-sitter` (4.7 MB) and `marked` are
pulled in for the syntax-highlighting and markdown renderables, which run-mux does not need; there
is no way to opt out.

### The blocker

```
Error: Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for
this runtime yet
    at resolveRenderLib (.../@opentui/core/chunk-node-aj3n20gq.js:17282:13)
    at new CliRenderer (.../@opentui/core/src/renderer.ts:1047:17)
```

`@opentui/core` has exactly two FFI backends and no fallback:

```js
function loadBackend() {
  if (isBun) return createBunBackend(requireModule("bun:ffi"))
  try {
    const nodeFfi = requireModule("node:ffi")
    return createNodeBackend(nodeFfi.default ?? nodeFfi)
  } catch (error) {
    return createUnsupportedBackend(error)   // every call throws FFI_UNAVAILABLE
  }
}
```

Its bundled `bun-ffi-structs` states the requirement outright:

> `bun-ffi-structs pointer operations require Bun or Node.js 26.1+ with node:ffi enabled (--experimental-ffi).`

There is no N-API addon, no WASM fallback, no `koffi`/`ffi-napi` path. Measured matrix
(`bash run-matrix.sh`):

| Node | flag | `node:ffi` | `createCliRenderer()` |
| --- | --- | --- | --- |
| 22.23.0 | (none) | absent | **FAIL** — FFI unavailable |
| 22.23.0 | `--experimental-ffi` | — | **`node: bad option: --experimental-ffi`** |
| 24.14.0 | (none) | absent | **FAIL** — FFI unavailable |
| 24.14.0 | `--experimental-ffi` | — | **`node: bad option: --experimental-ffi`** |
| 26.7.0 | (none) | absent | **FAIL** — FFI unavailable |
| 26.7.0 | `--experimental-ffi` | present | **OK (80x24)** |

Node 24 is the current LTS line and `.mise.toml` pins the project to **22.22.0**. Neither can run
this. The flag is not merely unset on 22/24 — it does not exist, so there is no opt-in.

**Pinning an older OpenTUI is not an escape hatch.** Every published version was installed in turn
and probed on Node 24.14.0 (`spike/vtest/`):

| version | result on Node 24 |
| --- | --- |
| 0.1.107 | `Unknown file extension ".scm"` — Bun-only file-type imports, does not even load |
| 0.2.16 | `bun-ffi-structs requires Bun or Node.js with node:ffi enabled (--experimental-ffi --allow-ffi)` |
| 0.3.4 | same `node:ffi` requirement |
| 0.4.0 / 0.4.5 | `OpenTUI native FFI is not available for this runtime yet` |
| 0.5.0 / 0.5.3 | `OpenTUI native FFI is not available for this runtime yet` |
| 0.5.3 on Node 26.7.0 + `--experimental-ffi` (control) | **OK (80x24)** |

There has never been a Node backend that avoided `node:ffi`. The project is Bun-first; the Node
path was added on top of an FFI API that only reached Node in 26.1.

### Things worth flagging on the new dependency

- **`react-devtools-core` and `ws` are declared as required peers but are not required.** The
  published `@opentui/react` manifest lists them in `peerDependencies` with **no
  `peerDependenciesMeta.optional`** — yet the package's own source manifest (visible inside the
  bundled chunk) *does* mark both optional. The `optional` markers were lost in packaging. Both
  were removed and the full mouse harness re-run: **all assertions still pass.** Keeping them costs ~16 MB
  for `react-devtools-core` alone. This spike's `package.json` omits them.
- **`bun-ffi-structs` declares `peer typescript@^5`** and warns against our TypeScript 6.0.2. It is
  a type-only peer; nothing broke.
- `@opentui/react`'s `testRender` never wraps dispatch in `act()`, so React logs a
  "not wrapped in act(...)" warning for every synthetic event. Cosmetic, but it buries harness
  output until you filter it.
- The `@opentui/react` type surface is real and complete — the whole spike typechecks under
  `strict` with `tsc --noEmit` and zero errors, including the mouse event types.

### Project maturity — the part to be uncomfortable about

Signals as of 2026-08-17 (repo `anomalyco/opentui`, MIT, created 2025-07-21):

| signal | value |
| --- | --- |
| stars / forks / contributors | 13,031 / 690 / 111 |
| open issues / open PRs | 95 / 122 |
| last commit | 2026-08-16 — 52 commits in the last 30 days |
| latest release | v0.5.3, 2026-08-13 (a minor every 6–8 weeks, patches every few days) |
| production use | the project states OpenTUI powers OpenCode |

The uncomfortable part is the project's **own** roadmap (issue #821): *"Now — v0.1 … v0.5:
exploring the problem space"*, *"Next — v0.x: refactor the hell out of it"*, *"Later — v1.0: move
the renderable tree and rendering native"*. By its maintainers' description this is pre-stable
software with an architectural rewrite still ahead of it, and no dates attached to any phase.

Node's status upstream is likewise explicit and secondary. The merge that added it (PR #1149,
shipped in v0.4.0) says: *"Bun remains the primary runtime; Node.js 26 is now a validated second
target, requiring `--experimental-ffi` for native rendering… Runtime-plugin, Solid preload, and
Bun-plugin subpaths stay Bun-only for now."* Node support is real in CI — but **invisible in the
docs**: the README and the whole getting-started site are Bun-only, no page mentions Node or
`--experimental-ffi`, and `@opentui/core` declares no `engines` field. OpenTUI's own tooling
pins Node to exactly v26.4.0 and throws otherwise; this spike ran fine on 26.7.0, so that pin looks
like caution rather than a hard constraint, but it is worth knowing.

An N-API backend was considered and explicitly rejected — the maintainer's stated reason being that
*"the napi needs to be maintained to stay in sync with the native interface, which is far from
stable and changes almost daily."* There is no open plan to revisit it, so waiting for upstream to
make Node 22/24 work is not a milestone-planning assumption.

`node:ffi` itself: added in **Node v26.1.0 (2026-05-07)**, **Stability 1 – Experimental**, gated
behind `--experimental-ffi` and additionally `--allow-ffi` under the Permission Model, with an
explicit docs warning that it *"is inherently unsafe"*. It is not in any current LTS — Node 26.x
goes Active LTS **2026-10-28**. No roadmap, milestone or TSC statement proposes a date for
unflagging it, and the API is still being reshaped: an open issue proposes removing type aliases
*"while it's still experimental"*, and correctness bugs were being filed as recently as today.

---

## 2. Two-pane layout

### Holds everywhere. No tearing.

`src/app.tsx` builds what run-mux actually needs: a 32-column bordered sidebar of targets with a
status dot and a `mm:ss` elapsed column, and a right pane with a header, a row of five filter
chips, and a scrolling log area. Flexbox props (`flexGrow`, `flexShrink`, `width`) behave as you
would expect from CSS.

`./node26 src/layout-harness.tsx` — **40/40 pass** (`out/layout.txt`). At each of 80x24, 100x30,
120x40, 200x60, 45x12, 34x10, 160x50 it asserts structurally rather than by eye:

- frame has exactly `height` rows, and **every row is exactly `width` columns** (the tearing check);
- the sidebar's right edge sits at column 32 on *every* row;
- all six target names render, the header renders, the right pane shows log content.

At 34x10 — barely wider than the sidebar — it degrades without tearing rather than crashing or
emitting ragged rows.

**Resize storm:** 60 back-to-back resizes across 60-180 cols and 15-45 rows, then settle at
100x30. The resulting frame is byte-identical to a clean render at 100x30, so there is no stale
buffer left behind.

Rendered at 100x30:

```
+-targets----------------------+ run-mux - api - filter:all
| * api                  00:41 | all   stdout   stderr   warn   error
| * web                  00:39 |+-----------------------------------------------------------------+
| x worker               02:00 ||line 0000 lorem ipsum                                            |
| + migrate              05:00 ||line 0001 lorem ipsum                                            |
| - seed                 00:00 ||line 0002 lorem ipsum                                            |
| + typecheck            01:28 ||line 0003 lorem ipsum                                            |
+------------------------------++----------------------------------------------------------------+
```

(box-drawing characters flattened to ASCII here; the real frame dump is in `out/mouse.txt`)

It also runs for real: launched in an actual Windows Terminal window (`run-interactive.cmd`) it
rendered, streamed, and idled at **10.8% of one core, 256 MB RSS** while streaming ~200 lines/s
with the 1s tick running.

---

## 3. Mouse — the decisive test

### Passes completely. The Ink offset bug is absent.

Synthetic injection was **not** a problem, and it did not need the vendored mock. `src/sgr.ts`
builds raw SGR-1006 bytes (`ESC [ < btn ; col ; row M|m`) by hand and writes them onto
`renderer.stdin`, so the real `MouseParser` and the real hit-test path run. (The bundled
`createMockMouse` turns out to do the same thing — it generates genuine SGR strings and emits them
as `data` — but building them independently means the result does not depend on a test-only code
path being honest.)

`./node26 src/mouse-harness.tsx` — **29/29 pass** (`out/mouse.txt`). Rows and columns are located
by searching the *rendered frame*, not hard-coded, so a layout change would surface as a missing
row rather than a silently-passing assertion.

| Test | Result |
| --- | --- |
| Click each of the 6 sidebar rows in turn | Each hits its own row. **Row 3 (terminal row 4) reports `worker`, not `api` or `web`.** |
| Click the same row but right of the sidebar | Hits no target at all |
| Click each of the 5 filter chips | Each chip hits itself, at its own column |
| 3x wheel-down, then 2x wheel-up over the log pane | 3 and 2 scroll events on the log pane, direction decoded correctly |
| Click after the log pane has scrolled 20 notches | Reports **the line actually drawn on that row**, not the line originally there |
| Sidebar click after the log pane scrolled | Still correct (independent scroll origins) |
| Sidebar + chip clicks at 60x20, 140x44, 100x30 | Correct at every size, immediately after resize |
| Right-click, Ctrl+click | Routed to the same row; button and modifier bits decoded |

The reason it works, and Ink's doesn't: OpenTUI's `MouseEvent` is a DOM-shaped object with
`target`, `currentTarget`, `stopPropagation()` and `preventDefault()`, and the event carries
element-local coordinates. Clicking sidebar row 3 at terminal (5, 4) delivers local `(4, 3)` to
that row's handler. Hit-testing is done by the renderer against its own layout tree, so there is
nothing to build by hand.

Caveat: the wheel-scroll assertion counts events reaching `onMouseScroll` on the `scrollbox`. Each
injected wheel notch produced exactly one event — no coalescing, no duplication.

**Negative control.** 29 green assertions are worthless if the harness cannot go red, so the suite
ends by deliberately asserting the Ink failure mode — that clicking row 3 reports row 1 — and
requires that assertion to fail:

```
FAIL  [EXPECTED TO FAIL] clicking row 3 reports row 1 (the Ink bug)
      expected ["target:api@4,3"], got ["target:worker@4,3"]
PASS  harness reports red when the routing is wrong
```

That is the cleanest statement of the result: at the exact coordinate where Ink would have reported
the first row, OpenTUI reports `worker`, the third.

---

## 4. Throughput

### Coalescing is mandatory. With it, 5k lines/s is not close to the limit.

`./node26 src/throughput-harness.tsx <mode>` runs a real `createCliRenderer` (its own render loop,
not the manual test renderer) against a byte-counting stdout sink, with the sidebar's 1s elapsed
tick running throughout, and a real SGR click injected every 500ms to measure input responsiveness
under load. The producer is deadline-driven — a fixed batch on a 10ms interval under-delivers by
~40% on Windows because the default timer resolution is ~15.6ms.

**Naive** (one `setState` per line via `[...prev, line]`, unbounded retention) — 10s at 5k lines/s:

| metric | value |
| --- | --- |
| lines produced | 50,587 (4,991/s — the producer kept up) |
| frames | 381 (37.6 fps average, but see the curve) |
| RSS | 171 MB -> 482 MB, **peak 566 MB** |
| heap | 29 MB -> 211 MB, peak 282 MB |
| fps by second | 48, 49, 48, 48, 48, 46, 45, 31, **14** |

Extended to 30s it does not merely degrade, it **collapses**:

| metric | value |
| --- | --- |
| lines produced | 165,087 |
| lines that reached React state | 114,505 — **50,582 lines (31%) never arrived** |
| fps by second | 46, 48, 48, 46, 46, 42, 34, 27, 15, 6, 3, 2, 1, 1, 1, 1, 1 |
| RSS / heap | **678 MB / 539 MB** and still climbing |
| clicks answered | **28 of 60 injected** |

That last row is the real finding on responsiveness. Measured *latency* stayed low (p50 0.1ms) —
but that only averages the clicks that got delivered. Less than half the injected clicks were
delivered at all, because the event loop was so starved that the injecting timer itself stopped
firing. Naive is not survivable; the reported latency number would have hidden that if the harness
had not also counted attempts.

**Coalesced** (80ms flush timer, only the visible 60-line window kept in state) — 30s at 5k lines/s:

| metric | value |
| --- | --- |
| lines produced | 149,972 (**4,997/s sustained**) |
| lines into React state | 149,779 (99.87%) |
| React state commits | 342 (11/s — 437x fewer than naive) |
| frames | 428 (14.3 fps) |
| RSS | 171.4 MB -> 171.2 MB, **net growth -0.2 MB**; plateaus at 238 MB from t+12s |
| heap | sawtooths 34-56 MB for the whole run |
| native avg frame time | 1.44ms (max 4.33ms), ~198 cells updated per frame |
| clicks answered | **59 of 60**, p50 0.2ms, p95 0.5ms, max 2.0ms |

The 14.3 fps is not a shortfall — the renderer is demand-driven and only draws when the tree is
dirty, which at an 80ms coalesce interval is ~12.5 times a second. Frames per state commit is 1.25.

**Headroom**, coalesced, 10s each:

| rate | achieved | RSS peak | fps | clicks answered | p95 click |
| --- | --- | --- | --- | --- | --- |
| 5,000/s | 4,985/s | 229 MB | 14.2 | 19/20 | 2.1ms |
| 20,000/s | 19,930/s | 237 MB | 14.2 | 19/20 | 2.1ms |
| 50,000/s | 49,926/s | 239 MB | 14.5 | 19/20 | 4.7ms |

**10x the requirement, flat memory, no measurable frame cost.** Once you stop putting every line
into React state, the bottleneck is nowhere near the renderer — OpenTUI writes ~1.5 MB of stdout
across a whole 30s run because the native layer diffs frames and only emits changed cells.

The conclusion is not subtle: **virtualization plus coalescing is mandatory, and it is also
sufficient.** That is a requirement run-mux would have anyway — the log store is the place for
retention, not component state — so it costs nothing in design terms.

---

## 5. Text selection

### Native drag-select is suppressed. OpenTUI's own selection works and yields real text.

`./node26 src/selection-probe.tsx` (`out/selection.txt`). OpenTUI sets, on startup:

```
?1049h  alternate screen buffer      ?1000h  X11 mouse: press/release
?2027h  grapheme clustering          ?1002h  button-event tracking
?2004h  bracketed paste              ?1003h  ANY-EVENT tracking
?2031h  colour-scheme notification   ?1006h  SGR extended coordinates
?2026h  synchronised output
```

**`?1003` (any-event tracking) is the one that matters.** With it on, the terminal forwards every
mouse motion to the application, so the terminal's own drag-selection is fully suppressed for as
long as run-mux is in the foreground. Selecting a stack trace the normal way will not work by
default. This is inherent to mouse reporting, not an OpenTUI defect — any TUI with full mouse
support has the same problem.

Three usable answers:

**(a) OpenTUI has its own selection, and it produces real text.** Dragging across three rendered
log lines and calling `renderer.getSelection()!.getSelectedText()` returned:

```
"NT: no such file or directory, open 'config.json'\n    at Object.openSync (node:fs:561:18)\n    at readFileSync (node:fs:445:35)"
```

Multi-line, three renderables, column-accurate (the drag started at column 12, hence the truncated
`ENOE`). `getSelection()` / `hasSelection` / `clearSelection()` are public API, and there is a
`useSelectionHandler` React hook. So run-mux can implement copy itself — take the selected text and
push it to the clipboard via OSC 52 or `clip.exe`. **This is the path to take.**

**(b) Mouse reporting can be turned off at runtime through public API.** `renderer.useMouse = false`
emits resets for `?1003 ?1002 ?1000 ?1006`, and `= true` restores them. Verified in both
directions. So a "release the mouse" toggle (a keybinding, or a mode the user drops into to select
natively) is straightforward. Note that `CliRenderer.enableMouse()` / `disableMouse()` are
**private** — `useMouse` is the supported knob; do not reach for the private ones.

**(c) Shift bypasses mouse capture in Windows Terminal, and the app cannot revoke it.** This half
is the terminal's decision, not the app's, so it was answered from Windows Terminal's source rather
than by injection. `ControlInteractivity::_canSendVTMouseInput` returns false whenever Shift is
held:

```cpp
// If the user is holding down Shift, suppress mouse events
// TODO GH#4875: disable/customize this functionality
if (modifiers.IsShiftPressed()) { return false; }
return _core->IsVtMouseModeEnabled();
```

That check was added in the *same commit* that first gave Windows Terminal VT mouse support at all
(PR #4859, shipped in Preview v0.10.761.0, 2020-03-17) — there has never been a WT version with
mouse capture but no Shift escape. Microsoft documents it: *"If an application is in mouse mode,
hold down Shift to make a selection instead of sending VT input."* conhost does the same thing.
Crucially, **Windows Terminal does not implement XTSHIFTESCAPE** (`CSI > Ps s`), the sequence by
which an application can ask for shift-clicks to be delivered to it, so no application — including
run-mux — can take the user's Shift override away.

For completeness, injecting a shift-modified drag showed the app *would* see it correctly if a
terminal did forward it: 16 mouse events, shift modifier decoded, selection produced.

Three caveats on the Shift bypass:

- **Shift+wheel never reaches the app** in Windows Terminal. Both the VT-mouse and alternate-scroll
  paths are gated on Shift not being held, so the user gets WT's scrollback instead. A
  shift-modified wheel binding is not implementable there.
- **Shift+click re-anchoring in mouse mode was broken until 2026.** GH#9608 / GH#10963: with an
  existing selection, Shift+click extended it rather than starting a new one. Fixed by PR #19973,
  present from **stable v1.24.11911.0 (2026-07-16)**. Users on older Windows Terminal get a
  degraded selection experience.
- **The bypass key is not universal.** Shift in Windows Terminal, conhost, GNOME Terminal/VTE,
  Alacritty and WezTerm (configurable there). **iTerm2 uses Option/Alt — Shift means "extend
  selection".** VS Code's docs say Alt but xterm.js's `shouldForceSelection` returns
  `event.shiftKey` on Windows/Linux, so the docs look stale; treat VS Code as unverified.

So copy-out is a solved problem, with two independent mechanisms: the user's Shift-drag, and
run-mux's own selection-to-clipboard. Both should be implemented; neither is blocked.

---

## 6. The escape hatch: `@jitl/opentui-*` on plain Node 22/24

### It works. Every harness passes unmodified. The risk is the fork itself, not the code.

`@jitl/opentui-core` / `@jitl/opentui-react` are a third-party fork of upstream **0.4.0** that
replaces `bun:ffi`/`node:ffi` with **koffi**, a conventional prebuilt N-API FFI library. They
declare `engines: { node: ">=22.12" }`.

`spike/fork/` is the same spike, with `package.json` aliasing
`"@opentui/core": "npm:@jitl/opentui-core@0.4.0"`. **Not one line of `src/` was changed.** Results
on plain Node, no flags:

| harness | Node 24.14.0 | Node 22.23.0 |
| --- | --- | --- |
| mouse (incl. negative control) | **29/29 pass** | **29/29 pass** |
| layout (7 sizes + resize storm) | **40/40 pass** | **40/40 pass** |
| selection probe | identical behaviour to upstream | — |

Throughput is indistinguishable from upstream, and consistently a little *better* on memory and
frame time:

| metric | fork (plain Node 24) | upstream (Node 26 + flag) |
| --- | --- | --- |
| 30s soak, lines/s sustained | 4,993 | 4,997 |
| 30s soak, RSS peak | **194 MB** | 238 MB |
| 30s soak, clicks answered | 59/60 | 59/60 |
| 30s soak, native avg frame time | **1.13ms** | 1.44ms |
| 50,000/s headroom run | **49,846/s**, RSS peak 221 MB | 49,926/s, RSS peak 239 MB |
| real Windows Terminal, idle-streaming | **9.8% of one core, 176 MB** | 10.8% of one core, 256 MB |

The fork was run through the full suite: mouse, layout, selection, the 30s soak, the 50k/s headroom
run, and a real Windows Terminal launch — on both Node 22.23.0 and Node 24.14.0 for the assertion
harnesses.

### Why this is not a free win

- **Single maintainer, personal release stream.** Sole npm maintainer is `jitl`. The version list
  is dominated by `-branch-jake--…` CI tags rather than a curated release line.
- **Already drifting.** Latest is 0.4.0 against upstream 0.5.3, and nothing has been published
  since **2026-06-30**. There is no stated commitment to track upstream.
- **Upstream has not adopted it.** The author's upstream PR (a full koffi Node backend) was closed
  in favour of the maintainer's own `node:ffi` implementation. The follow-up ask to also support
  older Node upstream received no maintainer response. Upstream's position is explicitly
  "Bun is primary, Node 26 is a validated second target".
- **Bigger install.** koffi alone is **41 MB** (it bundles prebuilds for every platform), taking
  the fork's `node_modules` to 117 MB vs 82 MB for the upstream spike. koffi and `unsafe-pointer`
  also carry install scripts, which pnpm blocks by default — they were not needed here (the
  prebuilds resolved) but it is a supply-chain difference from upstream's genuinely zero-script
  install.
- One cosmetic wart: `Error: Failed to sync '<stdout>': Incorrect function.` on teardown **when
  stdout is redirected to `/dev/null` on Windows**. It does not occur when stdout is a real file or
  a real terminal, so it is an artifact of the test setup, not a defect that would reach users.

---

## What breaks, what is merely awkward, what could not be tested

### Breaks

- **Upstream OpenTUI cannot run on Node 22 or Node 24 at all** — two backends, no fallback, and
  the flag that enables the Node one does not exist before Node 26. The only workarounds are moving
  to Node 26 or taking the third-party fork in §6; there is no version of upstream to pin back to.
- **Naive log rendering collapses** — 31% line loss, 1 fps, 678 MB, half the input dropped, within
  30 seconds. Anyone who writes the obvious thing will produce something that looks fine in a demo
  and dies in real use.

### Awkward

- Running requires `--experimental-ffi`, so run-mux's `bin` would need to re-exec itself with the
  flag (or set `NODE_OPTIONS`) and produce a clear error on older Node instead of the current
  message, which tells a user nothing actionable.
- An experimental flag means Node prints `ExperimentalWarning: FFI is an experimental feature and
  might change at any time` on every start. It must be suppressed (`--no-warnings` or a warning
  listener shim) or every run-mux invocation is noisy.
- `--experimental-ffi` is process-wide, not scoped to OpenTUI. That is a real security surface
  expansion for a tool that supervises user processes; worth a conscious decision, not a shrug.
- ~27 MB of runtime dependencies, ~4.7 MB of which (`web-tree-sitter`) is for a feature run-mux
  will not use, with no way to opt out.
- The broken `optional` peer markers mean a default install pulls 16 MB of `react-devtools-core`
  that is never loaded.
- `testRender` not wrapping in `act()` makes React warning spam a fact of life in any test suite
  built on it.
- *(fork lane)* koffi is **41 MB** on its own, taking the install to 117 MB, and it plus
  `unsafe-pointer` carry install scripts that pnpm blocks by default. They were not needed here —
  the prebuilds resolved — but `onlyBuiltDependencies` may need an entry on other setups.
- *(fork lane)* `fork/src` has to be a copy rather than a symlink, because the `npm:` alias only
  applies to files resolving against `fork/node_modules`. Fine for a spike, mildly annoying to keep
  in sync.

### Could not test

- **Shift-drag was not verified by hand.** The Windows Terminal behaviour above is established
  from Microsoft's docs and the terminal's own source, not from a human dragging with Shift held.
  Synthetic injection into stdin cannot test it by construction — it only tells you what the app
  does once bytes arrive. `run-interactive.cmd` launches the spike in a real Windows Terminal
  window; **ten minutes of manual checking there would close this**, and would also confirm the
  Shift+click re-anchoring fix on whatever WT version the team actually runs.
- Terminals other than Windows Terminal were not exercised at all. Only Windows Terminal and a
  piped/headless stdout were run; the table above for conhost / VS Code / iTerm2 / Alacritty /
  WezTerm is from their documentation and source, not from testing.
- Long-run stability. The longest continuous run was 33s. Nothing suggests a leak in coalesced mode
  (RSS plateaued flat for 18 consecutive seconds), but an hours-long soak was out of scope.
- Non-Windows platforms, and win32-arm64.
- The fork's *provenance* — it is a single-maintainer build of a koffi shim over the same Zig core.
  It behaves identically here, but nobody has audited the shim, and `koffi` becomes a new
  transitive native dependency.
- Whether `node:ffi`'s callback/threading model has sharp edges under sustained load — the Node
  backend explicitly does not support threadsafe callbacks ("Node FFI callbacks are same-thread
  only and do not support threadsafe callbacks"), while the Bun backend does. Nothing in this
  spike hit that, but a feature that needs native events off-thread might.

---

## Recommendation

**Proceed with OpenTUI.** The M0 question was whether a mouse-driven, high-throughput TUI is
achievable on this stack, and the answer is an unambiguous yes with a wide margin. Nothing in any
of the experiments suggests the hand-rolled renderer is needed.

What still needs a decision is the runtime, and there are three options. In preference order:

**1. Ship on upstream OpenTUI, move run-mux's floor to Node 26.** Node 26 reaches Active LTS on
**2026-10-28**, roughly ten weeks out. Work required: bump `.mise.toml` off 22.22.0; make the
`rmux` bin re-exec itself with `--experimental-ffi` (or set `NODE_OPTIONS`); suppress the
`ExperimentalWarning`; and add a version check that fails with an actionable message instead of
`OpenTUI native FFI is not available for this runtime yet`. Accept that `--experimental-ffi` is
process-wide and that an experimental API can shift under a Node patch release.

**2. Ship on the `@jitl/opentui-*` fork now, on Node 22/24.** Buys immediate compatibility at the
cost of a single-maintainer dependency that is already drifting. Reasonable as a *bridge* to
option 1 — the alias is one line in `package.json` and this spike proves the application code is
identical either way — but poor as a permanent position.

**3. Vendor the fork's approach.** If neither of the above is acceptable, the koffi shim is a
small, well-understood layer, and forking it ourselves is far cheaper than a renderer. This is the
insurance policy, not the plan.

Whichever is chosen, two things are settled by this spike and should go straight into the design:

- **The log pane must coalesce (~80ms) and keep only the visible window in component state.**
  Retention belongs in the run store. This is not tuning; the naive version loses a third of its
  input and drops to 1 fps within 30 seconds.
- **Copy-out needs an explicit design.** Either wire `useSelectionHandler` +
  `selection.getSelectedText()` to the clipboard (OSC 52 / `clip.exe`), or document Shift-drag.
  Shift is the bypass in Windows Terminal, conhost, Alacritty and WezTerm; **iTerm2 uses Option
  instead**, so a hint in the UI should not name Shift unconditionally.

### Standing risk to keep visible

OpenTUI's own public roadmap describes 0.1–0.5 as *"exploring the problem space"* and 1.0 as
*"move the renderable tree and rendering native"* — i.e. an architectural rewrite is planned, not
just stabilisation. Releases land every few days. This is a fast-moving 0.x with 13k stars and 111
contributors, not a settled dependency. Pin exact versions (the repo already requires this) and
expect to spend real effort on upgrades.

### What is reusable if this is ever revisited

- `src/sgr.ts` and the harness approach — raw SGR injection into stdin with assertions on which
  handler fired is exactly how you would test any hit-tester, and it is framework-agnostic.
- `src/throughput-harness.tsx`'s methodology, in particular counting *attempted* input events
  rather than only the latency of delivered ones. That is what exposed the naive collapse; latency
  alone looked healthy right up to the point where half the input was being dropped.
- The layout harness's structural invariants (every row exactly `width` columns, sidebar edge at a
  fixed column on every row) are a good tearing check for any renderer.
- `src/app.tsx` is throwaway — it is bound to OpenTUI's JSX intrinsics.

---

## Follow-up: Bun was considered and declined (2026-08-17)

Bun 1.3.14 is installed on this machine and would remove the `node:ffi` problem entirely — OpenTUI
treats Bun as its primary target, `bun:ffi` is stable, and no flag is needed.

**Verified**: a Bun client using `node:net` connects to a Node-served Windows named pipe and
completes a full request/response round trip, hello frame included. So a Bun TUI talking to a Node
daemon is a working configuration, not a theory.

**Declined anyway**, for now. Moving only the TUI would have worked, but the project chose to stay
on Node 26 + `--experimental-ffi` and keep one runtime. Moving the *whole* project was never the
option: the daemon serves named pipes, spawns detached process groups, tree-kills via `taskkill`,
and reaps orphans through `Get-CimInstance` with pid + creation-time matching — the least portable
code in the repo, with 221 tests proving it on Node.

This stays available as a bridge if `--experimental-ffi` becomes painful before Node 26 reaches
Active LTS (2026-10-28). The TUI is spawned as a child process, so the switch is a one-line change
to the launcher; the application code is identical either way.
