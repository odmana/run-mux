# Config consolidation: keyed repos + repo-key slugs

**Date:** 2026-08-17
**Scope:** three changes — nest playbooks under keyed repo entries, put the repo key in the target
slug, and add `rmux config edit`. No migration path: run-mux is not deployed, so the old shape is
simply dropped.

**Explicitly out of scope:** folding `targets` overrides onto the playbook, renaming
`repos[].alias` → `name` (it disappears entirely here anyway), `cwd` instead of `cd X &&`, and
playbook-level `defaults`. Those stay on the list for later.

---

## The two problems

1. A repo is named three ways in one file: `repos[].path`, `playbooks[].repo` (the same absolute
   path repeated), and the `targets` key prefix (a slugified basename). `playbooks[].repo` is a
   free string that nothing checks against `repos`, so a playbook can name a repo that was never
   registered and simply never resolve.

2. `slugFor` builds the repo segment from `basename(repoPath)` and ignores the registered alias
   (`src/state/targets.ts:50`). Every TicketSolutions slug therefore begins `ticketsolutions-`,
   which makes prefix resolution useless across those repos — which is why the live config carries
   nine hand-written target aliases that exist only to work around it.

Note that `README.md:54` already documents slugs as `orders/main:run-orders`. The docs describe the
world after change 2; the code doesn't produce it yet.

---

## Target format

```json
{
  "repos": {
    "orders": {
      "path": "~/projects/TicketSolutions.Orders",
      "playbooks": [
        {
          "name": "Run Orders",
          "commands": [
            { "label": "Build", "type": "task", "command": "dotnet build src" },
            { "label": "Web", "command": "cd src/TicketSolutions.Orders.Web && dotnet run --no-build", "dependsOn": ["Build"] }
          ]
        }
      ]
    }
  },
  "targets": {}
}
```

The key **is** the repo's name: unique by construction, always present, lowercase and slug-safe by
validation, and the same string you type at the CLI. `repos[].alias` and `playbooks[].repo` both
disappear. A playbook is one shape everywhere — the global file and `.run-mux.json` now agree.

Resulting slug: `orders/main:run-orders`, `orders/feat-x:run-orders`.

---

## Change 1 — nest playbooks under keyed repos

### `src/types.ts`

```ts
export interface RepoRegistration {
  path: string;
  playbooks: Playbook[];
}

export interface GlobalConfig {
  repos: Record<string, RepoRegistration>;
  targets: Record<string, TargetOverrides>;
}
```

Delete `GlobalConfig.playbooks` and `RepoRegistration.alias`. `ResolvedPlaybook` is unchanged — it
still carries `repoPath` and `source`.

### `src/config/schema.ts`

- **Delete `GlobalPlaybookSchema`.** Its only reason to exist was the extra `repo` field. This is
  the change that collapses the two spellings of one concept.
- **Add a repo-key schema** so the key can never need slugifying:
  ```ts
  const RepoKey = v.pipe(
    v.string(),
    v.regex(/^[a-z0-9][a-z0-9-]*$/, 'a repo key must be lowercase letters, digits and hyphens'),
  );
  ```
- **`RepoRegistrationSchema`** becomes `{ path: NonEmptyString, playbooks: v.optional(v.array(PlaybookSchema), () => []) }`.
- **`GlobalConfigSchema.repos`** becomes `v.optional(v.record(RepoKey, RepoRegistrationSchema), () => ({}))`.
- **Replace `duplicateGlobalNames`** — object keys make per-repo playbook-name collisions across
  entries impossible, but two things still need checking:
  - duplicate playbook names *within* one repo entry. `RepoConfigSchema` already does this inline;
    extract it as `duplicatePlaybookNames(playbooks)` and use it from both places.
  - two different keys pointing at the same `path`, which would make the key→path lookup ambiguous.
    Add a `v.check`. Reuse the path-normalising logic currently inlined in `duplicateGlobalNames`
    (forward-slash, strip trailing slashes, lowercase on win32) — lift it to a `configPathKey`
    helper rather than deleting it with its caller. It must stay local to `schema.ts`:
    importing `canonicalPath` from `resolve.ts` would close an import cycle
    (`resolve` → `load` → `schema`).
- `SchemaMatchesContract` keeps both assertions honest with no edit.

### `src/config/load.ts`

- `emptyGlobalConfig()` → `{ repos: {}, targets: {} }`.
- The `loadGlobalConfig` post-parse mapping (`load.ts:62-70`) currently expands paths on two
  collections; it now expands one:
  ```ts
  repos: Object.fromEntries(
    Object.entries(parsed.repos).map(([key, repo]) => [key, { ...repo, path: expandPath(repo.path) }]),
  ),
  ```
- `STARTER_CONFIG` — rewrite the skeleton to `{ "repos": {}, "targets": {} }` and shorten the `//`
  block; the "a global playbook names the repo it belongs to" line is now false.

### `src/config/resolve.ts`

`resolvePlaybooks` keeps its signature and its precedence rule. The global loop changes from a
filter over a flat list to a single lookup, and the `const { repo: _repo, ...playbook }` destructure
goes away:

```ts
const entry = Object.values(global.config.repos).find((r) => samePath(r.path, owner));
for (const playbook of entry?.playbooks ?? []) {
  const resolved: ResolvedPlaybook = { ...playbook, repoPath: owner, source: 'global' };
  const existing = playbooks.findIndex((pb) => pb.name === resolved.name);
  if (existing === -1) playbooks.push(resolved);
  else playbooks[existing] = resolved;
}
```

Add the lookup that change 2 needs, here beside `samePath`:

```ts
/** The config key for a registered repo, or undefined when it isn't registered. */
export function repoKeyFor(config: GlobalConfig, repoPath: string): string | undefined {
  return Object.entries(config.repos).find(([, r]) => samePath(r.path, repoPath))?.[0];
}
```

It takes the config rather than loading it, so the daemon can pass its cached copy.

### `src/config/index.ts`

Drop the `GlobalPlaybookSchema` export; add `repoKeyFor`.

### `src/daemon/methods.ts`

- `repoList` (`:121`) → `Object.entries(config.repos).map(([key, repo]) => repoView(key, repo.path))`.
- `repoView` (`:535`) → `repoView(key: string, repoPath: string)`, with `name: key`. The
  `alias ?? basename(repoPath)` fallback goes; `RepoView` on the wire is unchanged, and
  `picker.ts:94`'s comment about `name` already being the alias stays true.
- `configReload` (`:271`) → `for (const repo of Object.values(reloaded.config.repos))`.
- `repoAdd` (`:107-117`) — `raw.repos` is an object now, so `asArray` becomes an `isRecord` guard,
  and the entry needs a key minted from the basename, deduped with a numeric suffix when taken:
  ```ts
  const key = params.name ?? mintRepoKey(existing, basename(root));   // slugify + -2, -3 on collision
  ```
  Registering `TicketSolutions.Orders` bare would otherwise mint `ticketsolutions-orders`, which is
  exactly the long key the change exists to escape — so also add **`rmux repo add <path> --as <name>`**:
  `RepoAddParams` gains `name?: string` (`src/protocol.ts:100`), `cli/commands/repo.ts` reads it via
  `flagString(ctx.args, 'as')`, and an explicit name that is already taken is a `conflict` error.
  Guard it with the same `RepoKey` regex so the CLI can't write a config the loader then rejects.
- `repoRemove` (`:124-139`) — match on key **or** path, and `delete` from the object.
- `mutateGlobalConfig` (`:662`) is untouched: it works on raw JSON precisely so the `//` block
  survives, and that still holds.

### Tests

- `test/config.test.ts` — the bulk of it. Global fixtures at `:70`, `:264`, `:303-340` move to the
  nested shape; the four empty-config assertions (`:216`, `:231`, `:246`, `:258`, `:280`) become
  `{ repos: {}, targets: {} }`. Add coverage for the new rejections: a bad repo key, and two keys
  sharing one path.
- `test/daemon.test.ts` — `patchGlobalConfig` (`:183`) and its caller at `:523`.

---

## Change 2 — the repo key in the slug

### The one decision

An unregistered repo has no key, and `rmux add <path>` accepts any path with a `.run-mux.json`
(`cli/commands/target.ts:96`), so unregistered targets are legitimate and must keep working.

Resolve it by **making the key a required input to `slugFor` and putting the fallback at the call
site**. `state/` stays free of config imports — the same reason `resolveTarget` takes its alias map
as a parameter (`targets.ts:112`) — and `slugFor` itself has exactly one code path.

### `src/state/targets.ts`

`slugFor` needs `repoPath` for the `isMain` determination *and* a repo name for the segment, so the
positional list is at five and should become an object:

```ts
export interface SlugInput {
  repoKey: string;
  repoPath: string;
  checkoutPath: string;
  playbookName: string;
  checkout?: CheckoutHint;
}

export function slugFor(input: SlugInput): string {
  const resolved = input.checkout ?? findCheckout(input.repoPath, input.checkoutPath);
  const isMain = resolved?.isMain ?? samePath(input.repoPath, input.checkoutPath);
  const segment = isMain ? MAIN_SEGMENT : resolved?.branch || basename(canonicalPath(input.checkoutPath));
  return `${input.repoKey}/${slugify(segment)}:${slugify(input.playbookName)}`;
}
```

The key is already slug-safe by schema, so it is **not** re-slugified — that would silently mask a
key the validator should have rejected. `CreateTargetInput` gains `repoKey: string` and passes it
through at `targets.ts:79`.

### `src/daemon/methods.ts`

`targetAdd` (`:168`) is the only caller, and owns the fallback:

```ts
const config = ctx.globalConfig().config;
const repoKey = repoKeyFor(config, repoPath) ?? slugify(basename(repoPath));
const created = createTarget({ repoKey, repoPath, checkoutPath, playbookName });
```

`slugify` is already exported from `state/index.ts:35`.

### Optional, decide when you get there

`MUX_REPO_NAME` (`:376`) is `basename(repoPath)`. Setting it to the repo key would make every
name the user sees consistent. It changes a variable commands can read, so it is a real behaviour
change — nothing in the live config consumes it, so it's cheap, but it isn't required by either
change. Left out unless you want it.

### Tests

`test/state.test.ts:232-252` — the four `slugFor` cases move to the object argument. `:244` is the
one that matters: it asserts today's `basename` behaviour on `/src/TicketSolutions.Orders` and
should be rewritten to assert that a key of `orders` produces `orders/main:run-orders`.

---

## Change 3 — `rmux config edit`

Open the global config in `$EDITOR`, and reload when the editor closes. It joins the existing
`config` group, beside `config resolve`.

### Why it earns its place here

`loadGlobalConfig` answers a parse failure with an **empty** config plus a problem string
(`load.ts:52-60`). A stray comma therefore doesn't fail loudly — it silently unregisters every repo
and every playbook, and the only signal is a warning on stderr. Hand-editing is how this config is
maintained, so the edit path is exactly where that deserves to be caught. The command validates
before it returns and offers to reopen, which turns a silent wipe into a prompt.

### Two decisions

**It must work with no daemon running.** You should be able to repair a broken config without one,
and autospawning a daemon to open a text editor is absurd. So the command resolves the path and
validates locally, and reloads only if a daemon is already up — via `tryConnect`, never
`ctx.client()`. This is the same rule, for the same reason, that `daemon status` and `daemon stop`
already follow (`cli/commands/daemon.ts:4-6`).

**This puts the first `config/` import in `cli/`.** Nothing under `src/cli/` imports `src/config/`
today; every verb reaches config through the daemon. The exception is deliberate and narrow:
`ensureGlobalConfig()` to create the starter file, and `loadGlobalConfig()` to validate — both leaf
functions over `paths.ts`, which the CLI already imports (`daemon.ts:10`). It does **not** open the
door to the CLI resolving playbooks or writing config; those stay daemon-side. Worth a one-line
comment at the import saying so.

### `src/cli/commands/config.ts`

```
rmux config edit
```

1. Reject `--json` and a non-TTY stdin with `bad_params`, exactly as `rmux add` does when it would
   otherwise prompt (`cli/commands/target.ts:129`). An interactive editor cannot coexist with a
   pure-JSON stdout.
2. `ensureGlobalConfig()` — writes the self-documenting starter if the file is missing, so the
   editor never opens on nothing.
3. Resolve the editor: `$VISUAL`, then `$EDITOR`, then `notepad` on win32 and `vi` elsewhere.
4. Spawn it with `stdio: 'inherit'` so it owns the terminal, and await exit. Split the editor string
   on whitespace so `EDITOR="code -w"` works — the value is a command line, not a bare path.
   `ENOENT` becomes a `not_found` naming the editor that was resolved and the variable it came from.
5. On a non-zero editor exit, report it and skip the reload — assume the edit was abandoned.
6. Validate with `loadGlobalConfig()`. If `problems` is non-empty, print them and prompt
   `reopen? [Y/n]` on stderr (readline, as `choose()` at `target.ts:142` does), looping back to
   step 4 on yes. On no, exit `invalid_config` — the config is live and broken, and a zero exit
   would be a lie.
7. If a daemon is running, call `config.reload` and report `problems` and `stale` exactly as
   `rmux reload` does.

Step 7 is the same reporting `reload()` already contains (`config.ts:34-46`) — factor its body into
a shared `reportReload(ctx, result)` and have both verbs call it, rather than growing a second copy
of the stale-target message.

### GUI editors

`code`, `subl` and friends return the instant the window opens, so the reload would fire before the
file is saved. Their wait flags fix it (`code -w`). Document it in the `rmux help config` text
rather than trying to detect it.

### Wiring

- `src/cli/index.ts` — `config: { resolve: configCmd.resolve, edit: configCmd.edit }` (`:42`), a
  line in the top-level help (`:63`), and the `config` entry in the per-verb help (`:140`), which is
  where the `EDITOR="code -w"` note goes.
- No protocol change: `config.reload` already exists and already returns what this needs.

### Tests

`test/cli.test.ts`. The editor is the only awkward part, and it's the same seam the daemon and TUI
already use — set `EDITOR` to a fixture script (`test/fixtures/`) rather than a real editor:

- an editor that rewrites the file to valid content → config reloads, new content is live;
- an editor that writes broken JSON → problems are reported and the exit code is `invalid_config`
  when the prompt is declined;
- `--json` and non-TTY are both rejected;
- a missing config file is created before the editor is invoked;
- an unresolvable `$EDITOR` produces a `not_found` naming it.

The reopen prompt needs stdin, so drive it the way the existing prompt tests drive `rmux add`.

---

## Order of work

Three commits. Change 1 must land first because change 2 consumes `repoKeyFor`; change 3 is
independent of both and could go first or last, but reads best last, when the format it edits is the
final one.

1. **`refactor(config): nest playbooks under keyed repo entries`** — types, schema, load, resolve,
   index, the `methods.ts` repo verbs, `repo add --as`, and the two test files. Green before moving on.
2. **`refactor(state): build target slugs from the repo key`** — `slugFor`, `CreateTargetInput`,
   the `targetAdd` call site, `test/state.test.ts`.
3. **`feat(cli): add rmux config edit`** — `cli/commands/config.ts`, `cli/index.ts`, the editor
   fixture and `test/cli.test.ts`.

`pnpm check` after each (lint, format, typecheck, build, tests).

### Docs to follow

- `README.md:130-131` — "Registered repos, aliases, secrets, and playbooks" no longer describes the
  file; there are no aliases in it. Worth showing the global shape here, since it's currently only
  described in prose.
- `README.md:106-122` — the command list gains `rmux config edit`.
- `README.md:54` becomes accurate rather than aspirational — no edit needed.
- `CLAUDE.md` needs no change; `src/config/` still does what its line says.

---

## Local cleanup

Not a migration, but this machine has live state that change 2 invalidates: `state.json` holds nine
targets whose slugs are all about to change, and two Inventory children are currently running
(pids 25040, 29728).

1. `rmux daemon stop` first, so those two children are reaped rather than orphaned.
2. Delete `%LOCALAPPDATA%/run-mux/state.json` (and `runs/`, whose directory names derive from the
   old slugs via `slugToDirName`).
3. Rewrite `%APPDATA%/run-mux/config.json` into the new shape — mechanical, and the eight
   `playbooks[].repo` lines tell you which key each playbook belongs under. Keys: `demo`, `studio`,
   `orders`, `outlet`, `bank`, `inventory`, `localtix`, `oztix`. Once change 3 has landed this is
   `rmux config edit`, which is also the first real exercise of it.
4. Drop the whole `targets` block. After change 2 every one of those nine aliases is reachable as a
   unique slug prefix — `studio`, `orders`, `bank`, `inventory`, `localtix`, `oztix` each match one
   target, and `outlet` disambiguates by playbook (`outlet/main:run-online-outlet` vs
   `outlet/main:watch-online-outlet`, so `outlet/main:r` and `outlet/main:w`). If that last pair
   proves annoying to type, it's the argument for doing item 3 of the original list next.
5. `rmux add` each target back, then `rmux ls` to confirm the new slugs.
