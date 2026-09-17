# omo-routing

[한국어](README.ko.md)

Senpi/OMO extension that prints the model routing **configured** in
`~/.omo/omo.jsonc`: the per-category and per-agent model chains for the
current profile, a named profile, or the base config.

## What it does

```
/routing            current profile (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR tail; else base)
/routing <profile>  that profile's overlay applied on top of the base config
/routing base       base config only, no profile overlay
/routing off        hide the widget (a bare /routing also toggles it off)
/routing help       usage for every form (also -h / --help)
```

The widget is also cleared on `/reload` and session start.

An unknown profile name is an error that lists the available profiles.

### Editing chains

```
/routing set    <name> <model...>   replace the chain with exactly these rungs, in fallback order
/routing add    <name> <model...>   append rungs (duplicates skipped)
/routing remove <name> <model...>   drop rungs
```

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
- The chain shown before the edit is the *effective* one (profile over base),
  so `add`/`remove` on an entry inherited from base materialize it in the
  profile with the merged result.

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

- `profile: <p>   model_profile: <mp>   available: <a, b>` — the profile
  actually applied, the resolved `[senpi].model_profile`, and all profiles
  defined in omo.jsonc
- `warning:` — present when a requested profile does not exist (base config
  shown instead)
- `main (<name>)  ...` — the main-session chain from
  `model_profiles.<name>.models`; omitted when no `model_profile` is set or
  its chain is empty
- `categories:` — one row per `categories.<name>`, sorted
- `agents:` — one row per `agents.<name>` (subagent types such as
  `explore`, `librarian`, `plan-reviewer`; omo-task.js reads
  `agents.<subagentType>`), sorted

Each chain is one row: `name  provider/model:variant -> next -> ...`,
left to right in fallback order, names padded to a shared column width. An
entry with no models prints `(no chain configured)`. Category/agent blocks
are omitted when empty.

## Config resolution

Mirrors `omo-task.js` exactly:

- Profile name: `OMO_PROFILE` → `OCX_PROFILE` → basename of
  `OPENCODE_CONFIG_DIR` when it ends in `profiles/<name>`.
- Layers merge in order: base → `[senpi]` → `profiles.<name>` base →
  `profiles.<name>.[senpi]`. Objects deep-merge; arrays and scalars replace.
- `omo.jsonc` comments (`//`, `/* */`) are stripped before parsing; `omo.json`
  is used when no `.jsonc` exists.

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

- Configured routing only: chains are printed exactly as written in omo.jsonc.
  Nothing is checked against live provider state — no registry availability,
  no `auth.json` credentials, no `credential-pool-state.json` backoff.
- Builtin category chains that live in `omo-task.js` (not in omo.jsonc) are
  not shown; a category with no `models` in omo.jsonc prints
  `(no chain configured)`.
- `set`/`add`/`remove` are the only writes, and they only touch the one
  `models` array (plus a sibling `model` key on `set`); provider state is never
  touched. `/routing profile <name>` switching is not offered: the profile is
  fixed by the environment when the host starts.
- Where the host supports `ctx.ui.setWidget`, the table is shown above the
  editor and nothing is toasted; otherwise the whole report goes to
  `ctx.ui.notify`. The widget is passed as a component factory
  (`render(width)`), not a string array, because senpi caps string-array
  widgets at 10 lines (`MAX_WIDGET_LINES`). Rows wider than the viewport wrap
  at `->` boundaries, continuation lines indented to the chain column.
