# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Senpi/OMO extension (`extension/routing.ts`) that registers a `/routing` command printing the per-category and per-agent model chains **configured** in `~/.omo/omo.jsonc` for the current profile, a named profile, or `base`, and editing those chains with `set|prepend|add|remove`. README.md is the authoritative spec: command forms, report layout, config resolution order, write rules. Read it before changing behavior. README.ko.md is its Korean translation: every behavior change to README.md must be mirrored there in the same commit.

## Commands

```sh
node --test                                   # all tests (Node >= 22.6; .mjs tests import the .ts via built-in type stripping; run inside omo or set OMO_BIN: fixtures borrow omo-ai's @babel/parser and one test reads the installed bundles)
node --test --test-name-pattern="profile"     # single test by name substring
cp extension/routing.ts ~/.omo/agent/extensions/   # install (no script; README has the curl/iwr one-liners), then /reload in omo
```

No build step, no lint, no dependencies. Never test against a live paid OMO session; the fake `pi`/`ctx` harness in `test/routing.test.mjs` is the only runtime used.

## Architecture

- `extension/routing.ts` exports pure helpers (`stripJsonc`, `parseJsonc`, `mergeConfig`, `resolveProfileName`, `profileNames`, `applyProfile`, `chainOf`, `formatRow`, `fitLines`, `widgetFactory`, `buildReport`) and `createRouting(pi, deps)`, which registers `/routing`. The default export just calls `createRouting`. `deps` injects `env` and `home` for tests.
- Command forms: `/routing` (current profile from env; toggles the widget off when already shown), `/routing <profile>` (named overlay), `/routing base` (no overlay), `/routing off` (hide), `/routing help` (usage from `HELP_LINES`, shown like a report), `/routing set|prepend|add|remove [--profile <p>|-p <p>|--base] <name> [<n>] <provider/model[:variant]...>` (edit a chain; `<n>` is a 1-based rung position for `set` only). The `argumentHint` stays short; the full syntax lives in `help`.
- Edits: `parseEditArgs` → `resolveTarget` (against the effective config) → `applyChainEdit` → `removeJsoncPath`/`setJsoncPath` on the raw text. `parseJsoncTree` is a position-aware JSONC parser (comments blanked to spaces so offsets hold); `setJsoncPath` replaces an existing value keeping its inline/multiline style, or inserts a nested literal at the deepest existing object with the surrounding indentation. Each mutation re-parses, so no offset bookkeeping across edits. The result is re-parsed before writing and the old file is copied to `omo.jsonc.bak`. Written layer: profile (or base) `[native]` when present, else a legacy `[senpi]` when present, else a new `[native]` unless the layer keeps routing keys at its root.
- The host keeps extension widgets across `/reload` while the extension closure is recreated, so `createRouting` clears the widget on `session_before_reload` and `session_start`; without that the first `/routing` after a reload redraws instead of hiding. Verified live in an Orca-managed omo TUI (2026-09-14), not only in the harness. An unknown profile name is an error notification listing available profiles.
- Config resolution mirrors `omo-task.js`: profile = `OMO_PROFILE` → `OCX_PROFILE` → `OPENCODE_CONFIG_DIR` tail; layers base → `[native]` → profile base → profile `[native]`, where a layer without `[native]` uses its legacy `[senpi]` (OMO renames `[senpi]`→`[native]` on load and drops it when both exist); objects deep-merge, arrays replace; `__proto__`/`constructor`/`prototype` keys are skipped.
- Builtin defaults: `loadBuiltinRouting(env)` parses `omo-task.js` (categories, agents, category inheritance) and `omo.js` (main model profiles) under `OMO_BIN/../plugin/extensions` with omo-ai's own `@babel/parser` (`createRequire` from the install root; `require(esm)`, so the loader stays synchronous). Tables are found by AST shape; only constant-data nodes (`isConstant`) are evaluated in a `vm` context, spreads bound from same-name array literals that must agree. Each section fails on its own into `defaults.unavailable` (warning line, `확인 불가` rows); the result is cached by bundle content hash. OMO exports neither these tables nor its resolvers (`Pg`/`Jg`/`resolveModelForDelegateTask` are sealed in the bundle, checked on beta.89), so there is nothing to call instead. After an OMO upgrade, `node --test` inside omo checks the installed bundles.
- Scope is deliberately trimmed: candidate chains only. No `modelRegistry.getAvailable()`, no `auth.json`, no `credential-pool-state.json`, no model-name validation against a registry. Do not reintroduce provider-state checks without an explicit user request. No `/routing profile <name>` switch: the profile is fixed by the environment at host start.
- Output: with `ctx.ui.setWidget` the table goes to the `routing` widget (`placement: "aboveEditor"`) as a component factory from `widgetFactory(lines)` — a string array would be cut at senpi's `MAX_WIDGET_LINES` (10). `fitLines` wraps rows to the render width. No toast on widget hosts; without a widget the full report goes to `ctx.ui.notify`.

## Conventions

- Tests drive the command end to end through the fake harness; add a test for every new command form, section, or resolution rule.
- Commit messages follow `routing: <what changed>`.
