# omo-routing

[한국어](README.ko.md)

Senpi/OMO extension that prints **effective routing candidates** from
`~/.omo/omo.jsonc` and the installed OMO builtin defaults: main-session,
category, and agent chains for the current profile, a named profile, or base.
It works without a user config. The reports do not check provider authentication
or availability; the interactive editor (`/routing edit`) hides candidates of
providers the running session is not connected to.

## What it does

```
/routing            current profile (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR tail; else base)
/routing <profile>  that profile's overlay applied on top of the base config
/routing base       base config only, no profile overlay
/routing models     categories grouped by model and fallback position
/routing edit       interactive editor for every chain (omo TUI; see "Interactive editor")
/routing off        hide the widget (a bare /routing also toggles it off)
/routing help       usage for every form (also -h / --help)
```

The widget is also cleared on `/reload` and session start.

An unknown profile name is an error that lists the available profiles.

### Categories by model

`/routing models` uses the current profile. Use
`/routing models --profile <name>` (or `-p <name>`) for a named overlay,
or `/routing models --base` for base.

Sections `1차`, `2차`, `3차`, and so on correspond to the first, second,
third, and subsequent candidates in each category's effective chain.
Each section has `모델` (model), `프로바이더` (providers), and
`담당 카테고리` (assigned categories) columns. Rows group by canonical model
ID and effort, across providers; display abbreviations do not affect grouping.
A builtin `{provider-a|provider-b}` group occupies one position, while
separate configured entries occupy separate positions. Repeated models at
different positions remain visible in each section.

This view includes enabled categories only, not main-session or agent chains.
It shows configured candidates with builtin defaults where applicable, not
execution history or provider availability. Long cells wrap; narrow views
stack cells in column order. No configuration is written.

### Editing chains

```
/routing set    <name> <model...>   replace the chain with exactly these rungs, in fallback order
/routing set    <name> <n> <model...>   replace rung n only (1 = first, as in the models view's 1차)
/routing prepend <name> <model...>  insert rungs at the front
/routing add    <name> <model...>   append rungs (duplicates skipped)
/routing remove <name> <model...>   drop rungs
```

- With `set <n>` and `prepend`, a model that already sits elsewhere in the
  chain moves to the new position instead of appearing twice; `add` leaves
  existing rungs where they are. `set <n>` past the end of the chain is an
  error and writes nothing. `<n>` is accepted by `set` only.

- `<model>` is `provider/model[:variant]`, e.g. `openai-codex/gpt-5.6-sol:high`.
- `<name>` is `main` (the chain of the effective `model_profile`),
  `main:<model_profile>`, a category name, an agent name, or an explicit
  `category:<name>` / `agent:<name>`. A bare name must match exactly one of
  the effective categories or agents; the explicit form creates a new entry.
- `--profile <name>` (short `-p <name>`) or `--base` picks the layer written. By default the
  current profile (same resolution as the report) is written, or base when no
  profile is set. A profile named by the environment that does not exist is an
  error, not a silent write to base.
- Inside the chosen layer the chain goes to `[native].<categories|agents|model_profiles>.<name>.models`
  — the section OMO applies for that layer: `[native]`, else a legacy
  `[senpi]` when that is the only one, else a new `[native]` (or the layer
  root when the layer already keeps those keys at its root and has neither).
  `set` also drops a singular `model` key so the chain is exactly what was set.
- The chain before the edit is the *effective* one (profile over base, with
  builtin defaults where applicable). `add`/`remove` materialize inherited
  candidates in the chosen layer. Builtin provider alternatives are expanded
  in declaration order into explicit `provider/model[:variant]` strings;
  editing therefore turns that default into a user-configured ordered list.
  Separately displayed agent fallback branches are not appended to an already
  configured chain. Removing all category/agent models can reactivate defaults.
- These commands require an existing omo.jsonc/omo.json (the interactive
  editor creates one when it saves); displaying defaults never creates a config file.

The edit is applied to the omo.jsonc text at byte offsets: comments, key
order, and the inline/multiline style of the touched value are preserved;
new entries take the surrounding indentation. The previous file is copied to
`omo.jsonc.bak` first, and the result is re-parsed before it is written. The
report is then redrawn for the layer written, prefixed with
`wrote <label> in profile <name>|base[ [native]|[senpi]]: <chain>` (the section
appears only when a harness section was the one written). The change takes
effect whenever the host next reads omo.jsonc. A malformed edit is an error
pointing at `/routing help`.

The report shows:

- `config profile: ...   available profiles: ...` — the applied config overlay
  and the names under `profiles` in the user config. `base (no overlay)` is
  not a model choice; `none defined` means no named config overlays exist.
- `main model chain (model_profile): ...` — the independent main-session
  model-chain selection. When unset, the host/session model is unchanged;
  no builtin main profile is selected automatically.
- `user config:` — the file read, or an explicit absence notice.
- `builtin defaults:` — the installed source path when loaded. Missing or
  unsupported source instead produces a warning and configured-only output;
  the report never claims defaults are in use when discovery fails. Category
  chains, agent chains and main model profiles are read independently: a
  section whose table cannot be read gets its own `warning: builtin ...
  unavailable` line and configured-only rows, while the others keep their
  builtin defaults.
- `warning:` also identifies an environment-selected profile that does not
  exist (base shown instead).
- `warning: project config <path> also sets routing ...` — OMO also merges the
  `.omo/omo.jsonc` (else `omo.json`) of the session's working directory and each
  parent up to, not including, home. Such a file that sets routing can override
  what the report and the editor show; one that cannot be read is named too.
- `builtin changes since last review (reviewed on OMO <version>): new N (...),
  changed N (...), removed N (...); /routing edit to review` — shown when
  `~/.omo/routing-builtin-snapshot.json` (see "Interactive editor") exists and
  the installed builtin routing differs from it. Reports never write that file.
- `main (<name>)`, `categories:`, `agents:` — the selected main chain and
  sorted category/agent rows, including builtin entries absent from config.

Each section uses a four-column table in this order:
`카테고리명` (name), `설명` (description), `라우팅` (routing),
`변경여부` (changed from defaults). Long values wrap inside their cells.
Change status compares the effective routing with OMO's builtin routing:
`기본` means unchanged, `변경` means different, and `확인 불가` means
the builtin defaults for that row's section could not be loaded (agent rows
also when category chains could not, since agents inherit category routing).
Merely having a user-configured entry
does not count as a change; model order and effort are significant.
Descriptions use configured `description`, then `display_name`, then the
installed builtin role text, or `-` if absent. They are summarized to the
first sentence and at most 60 terminal cells.

Routing cells show `provider/model:variant → next → ...` and source information.
Sources are `configured`, `builtin`, `configured + builtin`, `categories`
(an agent inherits category routing), or `unresolved`. Disabled entries are
marked `(disabled)`. An empty selected main profile stays visible rather than
silently disappearing. Empty category/agent sections are omitted.

Chain labels are **display-only** (also in builtin groups, fallback branches,
and edit results). Provider legend: `codex` = `chatgpt-subscription` or
`openai-codex`, `claude` = `anthropic-subscription` or `claude-sdk-oauth`
(OMO renamed the subscription providers in 2026-09), `gh` = `github-copilot`;
all others, including `devin`, stay unchanged. Effort legend: `X` = max, `E` = xhigh, `H` = high,
`M` = medium, `L` = low, `O` = off or none, `mi` = minimal, `au` = auto.
Only a final `:effort` suffix is shortened; model names such as
`swe-2-high` and unknown provider/effort values are preserved verbatim.
Object model entries read effort from `reasoning`, or `variant` when absent;
chain edits preserve that effort in the resulting canonical model strings.
Use full canonical IDs in `set`/`add`/`remove`: labels are not input aliases,
and parsing, matching, and stored IDs do not change. The legend is also in
`/routing help`, not repeated on every report.

`{provider-a|provider-b}/model` groups alternative providers within a single
builtin rung, not separate retry steps. Category defaults include their
preferred model before the builtin fallback table. Configured agents can
also show a separate `builtin fallback: ...` line in the routing cell, used if their own
candidates cannot resolve. These are pre-availability candidates, not a
promise that every listed model will run or that this is the live retry chain.

### Interactive editor

```
/routing edit             the current profile's layer, base one Tab away (base alone when no profile is set)
/routing edit -p <name>   that profile's layer (also --profile <name>)
/routing edit --base      base alone, no profile overlay
```

`/routing edit` opens an overlay in the omo TUI (`ctx.ui.custom`); anywhere
else it is an error pointing at `set|prepend|add|remove`. Every change is made
by selecting: no category name or model ID is typed.

The list holds every routing node of the installed OMO build: the selected main
profile (read-only when `model_profile` is unset or pins a model), then every
category and agent that is builtin or set in base or the profile. A category
added by an OMO release appears without updating this extension; user-only
nodes such as `implementer` are listed too. Each row has a state word for the
layer being edited:

- `빌트인` (builtin): neither layer sets a chain; OMO's builtin applies and
  follows OMO updates.
- `base`: editing a profile, and only base sets a chain.
- `커스텀` (custom): the edited layer sets its own chain.
- `비활성` (disabled): `disable: true` applies.
- `없음` (none): no chain anywhere.

Badges: `NEW`, `변경됨` (changed) and `제거됨` (removed) mark builtin changes
since the last review, `*` marks unsaved edits, and `⚠` marks a warning: a rung
the connected providers do not list, adjacent rungs of one model that differ
only in effort (limits are per account, so they are no fallback), or no
connected candidate at all.

Row chains and the detail pane under the list (description, this OMO version's
builtin chain, the previous builtin chain when it changed, the base and profile
overrides, the effective chain and warnings) show only candidates this session
can run. Connected providers come from `ctx.modelRegistry.getAvailable()`, the
list OMO itself filters builtin rungs with. Rungs of unconnected providers are
hidden behind a `+N 숨김` count, and builtin provider groups keep only their
connected providers; `h` shows the hidden rungs marked `(미연결)`. Without a
readable registry nothing is hidden, a notice says so, and no model can be
picked (removing, reordering and effort changes still work).

| View | Keys (also shown in the footer) |
| --- | --- |
| list | ↑↓ PgUp PgDn Home End move · Enter/→ open the chain · `r` follow (drop this layer's chain) · `x` disable/enable · `u` undo this node's edit · `h` hidden candidates · Tab base ↔ profile · `c` mark builtin changes reviewed · `s` save · `q`/Esc close |
| chain | ↑↓ move · `a` add after the cursor (Enter on `+ 모델 추가` too) · Enter replace the model · `e` effort · `d`/Delete/Backspace remove · `K`/`J` or Shift+↑/↓ move · `b` copy the builtin chain · `r` follow · `x` disable · `h` hidden · `u` undo · `s` save · Esc/←/`q` back |
| model picker | type to filter (every word must match the provider, id or name) · Backspace · ↑↓ · Enter pick · Esc cancel |
| effort | ↑↓ · Enter · Esc; `(없음)` means no `:effort` suffix |

The picker lists only connected models. Efforts come from the host's own
`getSupportedThinkingLevels` (imported from the pi-ai copy the installed OMO
uses), else from the model's metadata; a new rung starts at `high` when the
model offers it. The same candidate (model and effort) is not added twice; the
same model with another effort can be, and adjacent ones are marked `⚠`.

A node without a chain in the edited layer is shown with the chain it inherits
(base, then OMO's builtin) minus hidden rungs; the first change turns that into
the layer's own chain. `r` (follow) removes the layer's chain instead, so the
node tracks base or OMO's builtin, including future OMO updates, which a copied
chain (`b`) does not. A node without a builtin cannot lose its last model.

Edits are staged per layer and nothing is written until `s`; closing with
unsaved edits asks once. Saving applies every staged edit to omo.jsonc at byte
offsets, as `/routing set` does:

- a chain is written as `models` in the layer's `[native]` (a legacy `[senpi]`,
  the layer root or a new `[native]` by the same rule), and that node's `model`
  and `fallback_models` are removed from the layer, so the chain is exactly the
  one shown;
- follow removes that node's `model`, `models` and `fallback_models` from the
  layer, keeps keys such as `description`, and removes an entry left empty;
- the disable toggle writes or removes `disable` (turning a node back on in a
  profile whose base disables it writes `disable: false`).

Comments stay where they are, including those next to a removed entry or key.
The result must parse; the file as it was before the session's first save is
kept as `omo.jsonc.bak` (later saves in the same session keep that copy); a
missing omo.jsonc is created. If the file changed on disk after the editor
opened, the first `s` warns and a second `s` applies the edits on top of the
newer file. OMO watches omo.jsonc and hot-reloads it when it changes. A reload
would close the editor and drop unsaved edits, so while the editor is open it
holds reloads off (OMO shows `Hot-reload deferred: /routing edit is open; ...`),
and the saved changes are applied as soon as it closes; with OMO's hot reload
turned off, `/reload` applies them. The closing notice says so, and a shown
`/routing` widget is redrawn from the saved file.

Builtin changes: the editor keeps the builtin routing you last reviewed in
`~/.omo/routing-builtin-snapshot.json`. The first `/routing edit` records the
installed build silently, and a later open does the same for a section the
snapshot lacks (one that could not be read before). After an OMO update the header, the badges and the
detail pane show new, changed (old and new chain) and removed nodes, and flag
chains of yours that now hide a changed builtin. `c` makes the installed build
the new baseline. A builtin section that could not be read is neither compared
nor overwritten.

## Config resolution

Config overlays follow `omo-task.js`:

- Profile name: `OMO_PROFILE` → `OCX_PROFILE` → basename of
  `OPENCODE_CONFIG_DIR` when it ends in `profiles/<name>`.
- Layers merge in order: base → `[native]` → `profiles.<name>` base →
  `profiles.<name>.[native]`. Objects deep-merge; arrays and scalars replace.
  `[senpi]` is the legacy name of `[native]`: OMO renames it on load, so a
  layer's `[senpi]` applies only when that layer has no `[native]`, and is
  ignored otherwise. `[opencode]`, `[codex]` and `[omo]` never apply here.
- `omo.jsonc` comments (`//`, `/* */`) are stripped before parsing; `omo.json`
  is used when no `.jsonc` exists.
- Category nonempty `models` takes precedence over `model`; otherwise
  `model` and `fallback_models` apply. Without an explicit primary, the
  builtin preferred model precedes configured fallbacks and builtin rungs.
  Agent `model` precedes `models`, then inherited categories/builtin fallback
  can apply. Metadata-only or empty category/agent overrides retain defaults.
- A user `model_profiles.<name>` replaces the builtin profile completely,
  even with no models. `model_profile` can also directly pin `provider/model`.

Builtin discovery uses the host launcher's `OMO_BIN` to locate
`../plugin/extensions/omo-task.js` (categories, agents, category inheritance)
and `omo.js` (main model profiles). OMO exports neither these tables nor the
functions that resolve them, so the bundles are parsed with the
`@babel/parser` that omo-ai itself installs (resolved from the install root):
a JS parser reads the minified syntax (`!0`, `void 0`, spreads, quoting), not
a hand-written tokenizer. Tables are recognized by their AST shape, not by
minified variable names, field order or category names. Only constant data is
evaluated — literals, operators over them, arrays and plain objects — in a
separate `vm` context; calls, functions and any other reference are rejected
before evaluation. The bundles are never imported or run, and no model list is
copied into this extension. A shared provider list spread into a rung
(`providers:[...a8]`) is read from its array literal `a8=[...]` in the same
bundle; a spread with no such literal, or with conflicting ones, is
unsupported. The result is cached until the bundle contents change. Missing
files, a missing parser, unsupported expressions, or ambiguous tables produce
a visible warning for the affected section. Restart/reload the host after
upgrading OMO so the source on disk and the running host agree.

## Install

No clone needed: fetch the single file into the OMO extension dir.

```sh
# *nix / Git Bash
mkdir -p ~/.omo/agent/extensions && curl -fsSL https://raw.githubusercontent.com/yjacket/omo-routing/master/extension/routing.ts -o ~/.omo/agent/extensions/routing.ts
```
```powershell
# Windows
New-Item -Force -ItemType Directory "$HOME\.omo\agent\extensions" | Out-Null; iwr https://raw.githubusercontent.com/yjacket/omo-routing/master/extension/routing.ts -OutFile "$HOME\.omo\agent\extensions\routing.ts"
```

From a clone: `cp extension/routing.ts ~/.omo/agent/extensions/`.

Then `/reload` in a running session (or restart) and run `/routing`.

## Tests

```sh
node --test
```

Node ≥ 22.6: tests are `.mjs` and import `extension/routing.ts` directly
through Node's built-in type stripping. A fake `pi`/`ctx` harness supplies the
command registry and a temp `$HOME` with a fixture `omo.jsonc`. No senpi, no
LLM calls. Fixture installs borrow the `@babel/parser` of the omo-ai install
that `OMO_BIN` points at, so run the tests inside omo (or set `OMO_BIN`); one
test reads that install's bundles themselves, so an OMO upgrade that changes
their shape fails it.

## Limits

- The reports check nothing against live provider state: no registry
  availability, no `auth.json` credentials, no `credential-pool-state.json`
  backoff. Only `/routing edit` reads the session's connected models
  (`ctx.modelRegistry.getAvailable()`), to hide and offer candidates; it reads
  no credentials either. Builtin
  model/provider IDs are taken as declared by OMO, before registry alias
  normalization; only the display labels above are shortened. Session/CLI model overrides and runtime retry filtering are
  not inferred from this report.
- Builtins require `OMO_BIN`, the `@babel/parser` installed with omo-ai, and
  recognizable table shapes. Bare Senpi or a future incompatible bundle gets
  configured-only output with a warning for the affected sections, not
  guessed defaults.
- `set`/`add`/`remove` and the editor's save are the only writes to omo.jsonc.
  The commands touch the one `models` array (plus a sibling `model` key on
  `set`); the editor touches only `model`, `models`, `fallback_models` and
  `disable` of the nodes you changed, and entries it leaves empty. The editor
  also writes `~/.omo/routing-builtin-snapshot.json`. Provider state is never
  touched. `/routing profile <name>` switching is not offered: the profile is
  fixed by the environment when the host starts.
- Where the host supports `ctx.ui.setWidget`, the table is shown above the
  editor and nothing is toasted; otherwise the whole report goes to
  `ctx.ui.notify`. The widget is passed as a component factory
  (`render(width)`), not a string array, because senpi caps string-array
  widgets at 10 lines (`MAX_WIDGET_LINES`). All lines wrap to terminal cell
  width, preferring `→` boundaries, then provider-group `|`, then spaces, and splitting long model IDs,
  provider groups and paths only at grapheme boundaries (no clipping).
  Table continuations align within each column; when four columns cannot fit,
  each row stacks its cells vertically in the same order.
  CJK and emoji count as two cells, combining marks stay with their character,
  and ambiguous-width characters such as `→` count as one. In a one-cell
  viewport, wider glyphs are shown as lossless `\u{...}` code-point escapes.
