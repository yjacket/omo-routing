# omo-routing

[한국어](README.ko.md)

Senpi/OMO extension that adds `/routing`: an interactive editor in the omo TUI
for the main-session, category and agent model chains of `~/.omo/omo.jsonc`,
shown over the installed OMO builtin defaults for the current profile, a named
profile, or base. It works without a user config. The editor hides candidates
of providers the running session is not connected to; it reads no credentials.

## Usage

```
/routing             the current profile's layer, base one Tab away (base alone when no profile is set)
/routing -p <name>   that profile's layer (also --profile <name>)
/routing --base      base alone, no profile overlay
```

The current profile is `OMO_PROFILE` → `OCX_PROFILE` → the tail of
`OPENCODE_CONFIG_DIR` (see "Config resolution"). `/routing edit ...` is the
same command under its former name. An unknown profile name is an error that
lists the available profiles; any other argument is an error naming the options.

`/routing` opens an overlay in the omo TUI (`ctx.ui.custom`); anywhere else it
is an error. Every change is made by selecting: no category name or model ID is
typed.

The list holds every routing node of the installed OMO build: the selected main
profile (read-only when `model_profile` is unset or pins a model), then every
category and agent that is builtin or set in base or the profile. A category
added by an OMO release appears without updating this extension; user-only
nodes such as `implementer` are listed too. The overlay is framed, with its
title in the top edge; the frame is laid out again at every width, so resizing
the terminal redraws it whole (a view under 20 columns or 10 rows goes
unframed). Each row shows what the node is for (the first sentence of its
configured or builtin description, markdown emphasis removed) in its own column
while the chain keeps at least 36 columns; the detail pane always shows it for
the selected node. Each row also has a state word for the layer being edited:

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

The header also warns when the environment names a profile omo.jsonc lacks
(base is edited instead), when a builtin table could not be read (its nodes
show configured chains only), and when a project `.omo/omo.jsonc` (else
`omo.json`) in the session's working directory or a parent up to, not
including, home also sets routing or cannot be read: OMO merges such a file
over `~/.omo/omo.jsonc`, so it can override what the editor shows.

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
| list | ↑↓ PgUp PgDn Home End move · Enter/→ open the chain · `r` follow (drop this layer's chain) · `x` disable/enable · `u` undo this node's edit · `h` hidden candidates · Tab base ↔ profile · `c` mark builtin changes reviewed · `p` profile menu · `s` save · `q`/Esc close |
| profile menu | ↑↓ PgUp PgDn Home End · Enter/→ on `+ 새 프로필 저장` enters a name, on a profile asks to apply it · Esc/←/`q`/`p` back |
| apply confirmation | ↑↓ Home End pick cancel or apply · Enter confirm · Esc/←/`q` back to the menu |
| profile name | type the name · Backspace · Enter save · Esc back to the menu |
| chain | ↑↓ move · `a` add after the cursor (Enter on `+ 모델 추가` too) · Enter replace the model · `e` effort · `d`/Delete/Backspace remove · `K`/`J` or Shift+↑/↓ move · `b` copy the builtin chain · `r` follow · `x` disable · `h` hidden · `u` undo · `s` save · Esc/←/`q` back |
| model picker | type to filter (every word must match the provider, id or name) · Backspace · ↑↓ · Enter pick · Esc cancel |
| effort | ↑↓ · Enter · Esc; `(없음)` means no `:effort` suffix |

The picker lists only connected models. Efforts come from the host's own
`getSupportedThinkingLevels` (imported from the pi-ai copy the installed OMO
uses, nested under omo-ai or hoisted beside it by a bun global install), else
from the model's metadata; a new rung starts at `high` when the model offers
it. The same candidate (model and effort) is not added twice; the same model
with another effort can be, and adjacent ones are marked `⚠`.

A node without a chain in the edited layer is shown with the chain it inherits
(base, then OMO's builtin) minus hidden rungs; the first change turns that into
the layer's own chain. `r` (follow) removes the layer's chain instead, so the
node tracks base or OMO's builtin, including future OMO updates, which a copied
chain (`b`) does not. A node without a builtin cannot lose its last model.
`r` and `x` are independent: following drops only the chain and leaves
`disable` as it is, and toggling `disable` keeps the chain.

### Labels

Chains are shown with display-only labels. Provider legend: `codex` =
`chatgpt-subscription` or `openai-codex`, `claude` = `anthropic-subscription`
or `claude-sdk-oauth` (OMO renamed the subscription providers in 2026-09),
`gh` = `github-copilot`; all others, including `devin`, stay unchanged. Effort
legend: `X` = max, `E` = xhigh, `H` = high, `M` = medium, `L` = low, `O` = off
or none, `mi` = minimal, `au` = auto. Only a final `:effort` suffix is
shortened; model names such as `swe-2-high` and unknown provider/effort values
are preserved verbatim. What is saved is always the canonical
`provider/model[:effort]`. `{provider-a|provider-b}/model` groups alternative
providers within a single builtin rung, not separate retry steps.

### Saving

Edits are staged per layer and nothing is written until `s`; closing with
unsaved edits asks once. Saving applies every staged edit to the omo.jsonc text
at byte offsets: comments, key order and the inline/multiline style of a
touched value are preserved, and new entries take the surrounding indentation.

- A chain is written as `models` in the layer's harness section, the one OMO
  applies for that layer: `[native]`, else a legacy `[senpi]` when that is the
  only one, else the layer root when it already keeps routing keys there, else
  a new `[native]`. That node's `model` and `fallback_models` are removed from
  the layer, so the chain is exactly the one shown.
- Follow removes that node's `model`, `models` and `fallback_models` from the
  layer, keeps keys such as `description`, and removes an entry left empty.
- The disable toggle writes or removes `disable` (turning a node back on in a
  profile whose base disables it writes `disable: false`).

Comments stay where they are, including those next to a removed entry or key.
The result must parse; the file as it was before the session's first save is
kept as `omo.jsonc.bak` (later saves in the same session keep that copy); a
missing omo.jsonc is created. If the file changed on disk after the editor
opened, the first `s` warns and a second `s` applies the edits on top of the
newer file. OMO watches omo.jsonc and hot-reloads it when it changes. A reload
would close the editor and drop unsaved edits, so while the editor is open it
holds reloads off (OMO shows `Hot-reload deferred: the /routing editor is
open; ...`), and the saved changes are applied as soon as it closes; with OMO's
hot reload turned off, `/reload` applies them. The closing notice says so.

### Saving as a new profile

`p` opens the profile menu: `+ 새 프로필 저장` (save as a new profile) first,
then the existing profiles. Enter on the first row asks for a name; Enter on an
existing profile asks whether to apply it (see below). The name is
trimmed and must be new (an exact key match counts as taken), nonempty, free
of whitespace, control characters, `/` and `\`, and not a reserved key such as
`__proto__` or `[native]`. A `profiles` value that isn't an object is refused.

The new profile gets a `[native]` holding the configured routing the editor
shows as the effective result of the profile it was opened for (the current
or `-p` profile, or base alone), staged edits included, even while Tab has
base open: `model_profile`,
`model_profiles`, `categories` and `agents` of the merged config, verbatim.
Rungs of hidden providers and keys such as `description` are copied too.
Builtin chains are not copied, so a node without a configured chain keeps
following OMO's builtin, including later OMO updates. An empty result is a
valid profile that simply follows base and the builtins. A profile overlay
can't delete what base sets, so a snapshot that wouldn't resolve to exactly
the shown routing (say, a staged follow of a chain base keeps) is refused with
the first differing path; save that edit to base first, or undo it with `u`.

Only the new profile is written. Base, the source profile and your staged
edits stay as they were, so `s` still saves those edits to their own layer.
The save shares the editor's write rules: comments and formatting are kept,
the first write of the session leaves `omo.jsonc.bak`, and if the file changed
on disk since the editor opened, the first Enter warns and a second Enter adds
the profile to the newer file (any other key cancels). The menu then lists the
new profile, and the closing notice names it. Saving doesn't activate it:
the active profile stays the same until you apply one.

### Applying a profile

Enter on an existing profile in the `p` menu opens a confirmation showing the
active profile and the one to apply. Pick cancel or apply with ↑↓ and press
Enter; Esc goes back to the menu. Cancel leaves your edits and the environment
alone. With unsaved edits, cancel is preselected and the apply row says how
many edits it discards; they're dropped, never written.

Applying sets `OMO_PROFILE` to that profile, closes the editor and asks OMO to
reload the session in place. This is a profile apply plus reload, not a
process restart (a deliberate choice): the conversation, the working
directory and the current session's main model stay as they are, while OMO
re-reads the selected profile's settings. The profile's `model_profile` takes
effect where OMO reads it, not by switching the model this session is
already using.

Only a reload the host actually performs counts. If the profile is missing
or unsafe in the current file, the host lacks a reload API, the reload is
vetoed or deferred (a response or compaction in progress, another
extension), or it fails before the old runtime is torn down, `OMO_PROFILE` goes back to its previous value and the
editor reopens with your unsaved edits intact and a notice saying why.
If the host fails after teardown has started, its error is surfaced instead;
the old editor can no longer be restored and the selected profile remains set.

### Builtin changes

The editor keeps the builtin routing you last reviewed in
`~/.omo/routing-builtin-snapshot.json`. The first open records the installed
build silently, and a later open does the same for a section the snapshot
lacks (one that could not be read before). After an OMO update the header, the
badges and the detail pane show new, changed (old and new chain) and removed
nodes, and flag chains of yours that now hide a changed builtin. `c` makes the
installed build the new baseline. A builtin section that could not be read is
neither compared nor overwritten.

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
command registry, `ui.custom`, a model registry and a temp `$HOME` with a
fixture `omo.jsonc`. No senpi, no LLM calls. Fixture installs borrow the
`@babel/parser` of the omo-ai install that `OMO_BIN` points at, so run the
tests inside omo (or set `OMO_BIN`); one test reads that install's bundles
themselves, so an OMO upgrade that changes their shape fails it.

## Limits

- Nothing is checked against live provider state beyond the connected models
  the editor reads (`ctx.modelRegistry.getAvailable()`) to hide and offer
  candidates: no `auth.json` credentials, no `credential-pool-state.json`
  backoff. Builtin model/provider IDs are taken as declared by OMO, before
  registry alias normalization. Session/CLI model overrides and runtime retry
  filtering are not shown.
- Builtins require `OMO_BIN`, the `@babel/parser` installed with omo-ai, and
  recognizable table shapes. Bare Senpi or a future incompatible bundle gets
  configured chains only, with a warning for the affected sections, not
  guessed defaults.
- The editor's saves are the only writes to omo.jsonc: `s` touches only
  `model`, `models`, `fallback_models` and `disable` of the nodes you changed,
  and entries it leaves empty; saving a new profile only adds
  `profiles.<name>`. It also writes `~/.omo/routing-builtin-snapshot.json`.
  Provider state is never touched. Applying a profile writes nothing; it
  only sets `OMO_PROFILE` for this process and reloads.
