# omo-routing

[한국어](README.ko.md)

Senpi/OMO extension that prints **effective routing candidates** from
`~/.omo/omo.jsonc` and the installed OMO builtin defaults: main-session,
category, and agent chains for the current profile, a named profile, or base.
It works without a user config; it does not check provider authentication or availability.

## What it does

```
/routing            current profile (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR tail; else base)
/routing <profile>  that profile's overlay applied on top of the base config
/routing base       base config only, no profile overlay
/routing models     categories grouped by model and fallback position
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
- Inside the chosen layer the chain goes to `[senpi].<categories|agents|model_profiles>.<name>.models`
  (or the layer root when the layer already keeps those keys at its root).
  `set` also drops a singular `model` key so the chain is exactly what was set.
- The chain before the edit is the *effective* one (profile over base, with
  builtin defaults where applicable). `add`/`remove` materialize inherited
  candidates in the chosen layer. Builtin provider alternatives are expanded
  in declaration order into explicit `provider/model[:variant]` strings;
  editing therefore turns that default into a user-configured ordered list.
  Separately displayed agent fallback branches are not appended to an already
  configured chain. Removing all category/agent models can reactivate defaults.
- Editing still requires an existing omo.jsonc/omo.json; displaying defaults
  never creates a config file.

The edit is applied to the omo.jsonc text at byte offsets: comments, key
order, and the inline/multiline style of the touched value are preserved;
new entries take the surrounding indentation. The previous file is copied to
`omo.jsonc.bak` first, and the result is re-parsed before it is written. The
report is then redrawn for the layer written, prefixed with
`wrote <label> in profile <name>|base[ [senpi]]: <chain>` (`[senpi]` appears
only when that section was the one written). The change takes
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
  the report never claims defaults are in use when discovery fails.
- `warning:` also identifies an environment-selected profile that does not
  exist (base shown instead).
- `main (<name>)`, `categories:`, `agents:` — the selected main chain and
  sorted category/agent rows, including builtin entries absent from config.

Each section uses a four-column table in this order:
`카테고리명` (name), `설명` (description), `라우팅` (routing),
`변경여부` (changed from defaults). Long values wrap inside their cells.
Change status compares the effective routing with OMO's builtin routing:
`기본` means unchanged, `변경` means different, and `확인 불가` means
builtin defaults could not be loaded. Merely having a user-configured entry
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
and edit results). Provider legend: `codex` = `openai-codex`, `claude` =
`claude-sdk-oauth`, `gh` = `github-copilot`; all others, including `devin`,
stay unchanged. Effort legend: `X` = max, `E` = xhigh, `H` = high,
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

## Config resolution

Config overlays follow `omo-task.js`:

- Profile name: `OMO_PROFILE` → `OCX_PROFILE` → basename of
  `OPENCODE_CONFIG_DIR` when it ends in `profiles/<name>`.
- Layers merge in order: base → `[senpi]` → `profiles.<name>` base →
  `profiles.<name>.[senpi]`. Objects deep-merge; arrays and scalars replace.
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
and `omo.js` (main model profiles). Only literal data is read; the bundles are
never imported or executed, and no model list is copied into this extension.
The adapter recognizes the installed bundle's table shapes, not minified
variable names. Missing files, unsupported expressions, or ambiguous tables
produce a visible warning. Restart/reload the host after upgrading OMO so the
source on disk and the running host agree.

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
LLM calls.

## Limits

- Nothing is checked against live provider state — no registry availability,
  no `auth.json` credentials, no `credential-pool-state.json` backoff. Builtin
  model/provider IDs are taken as declared by OMO, before registry alias
  normalization; only the display labels above are shortened. Session/CLI model overrides and runtime retry filtering are
  not inferred from this report.
- Builtins require the recognizable installed source layout and `OMO_BIN`.
  Bare Senpi or a future incompatible bundle gets configured-only output with
  a warning, not guessed defaults.
- `set`/`add`/`remove` are the only writes, and they only touch the one
  `models` array (plus a sibling `model` key on `set`); provider state is never
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
