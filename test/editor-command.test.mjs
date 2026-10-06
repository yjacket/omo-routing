// `/routing edit` through the registered command: the fake ctx supplies
// ui.custom, a model registry and an installed-OMO fixture. No senpi, no LLM.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createRouting, parseJsonc } from "../extension/routing.ts"
import { fixtureDir } from "./fixture-dir.mjs"
import { KEY, MODELS, press, screen, select } from "./editor-fixture.mjs"

const TASK = `var cats={quick:[{providers:["chatgpt-subscription","openrouter"],model:"gpt-mini",variant:"low"}],deep:[{providers:["chatgpt-subscription"],model:"gpt-big",variant:"high"}]};var agents={explore:[{providers:["anthropic-subscription"],model:"claude-haiku"}],librarian:[{providers:["anthropic-subscription"],model:"claude-haiku"}]};`
const MAIN = `var p=Object.freeze({capable:{displayName:"Capable",models:[{providers:["anthropic-subscription"],model:"claude-opus",variant:"high"}]}});`
const CONFIG = `{
  // my routing
  "[native]": { "categories": { "deep": { "models": ["anthropic-subscription/claude-opus:high"] } } },
  "profiles": { "work": { "[native]": { "model_profile": "capable" } } }
}
`

function setup(t, { config = CONFIG, mode = "tui", custom = true, cwd } = {}) {
  const home = fixtureDir("routing-edit-")
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, "omo-ai")
  mkdirSync(join(root, "plugin", "extensions"), { recursive: true })
  mkdirSync(join(root, "bin"))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "omo-ai", version: "9.9.9-test" }))
  writeFileSync(join(root, "bin", "omo.js"), "// launcher")
  writeFileSync(join(root, "plugin", "extensions", "omo-task.js"), TASK)
  writeFileSync(join(root, "plugin", "extensions", "omo.js"), MAIN)
  mkdirSync(join(home, ".omo"))
  const cfgPath = join(home, ".omo", "omo.jsonc")
  if (config !== null) writeFileSync(cfgPath, config) // null: no config file at all
  let command
  let resolveOpen
  const notes = []
  const ctx = {
    mode, cwd: typeof cwd === "function" ? cwd(home) : cwd,
    modelRegistry: { getAvailable: () => MODELS },
    ui: {
      notify: (message, kind) => notes.push({ message, kind }),
      ...(custom ? {
        custom: (factory, options) => new Promise(done => {
          const editor = factory({ terminal: { rows: 50 }, requestRender() {} }, undefined, undefined, done)
          resolveOpen?.({ editor, options })
        }),
      } : {}),
    },
  }
  const events = {}
  createRouting({ registerCommand: (_name, def) => { command = def }, on: (name, fn) => { events[name] = fn } }, { home, env: { OMO_BIN: join(root, "bin", "omo.js") } })
  return {
    home, cfgPath, notes,
    /** Deliver a host event (e.g. session_before_reload) and return the handler's result. */
    fire: name => events[name]({ type: name }, ctx),
    snapshot: join(home, ".omo", "routing-builtin-snapshot.json"),
    run: args => command.handler(args, ctx),
    hint: () => command.argumentHint,
    /** Run `/routing <args>` and resolve with the overlay once it is open. */
    open: async args => {
      const opened = new Promise(resolve => { resolveOpen = resolve })
      const finished = command.handler(args, ctx)
      return { ...(await opened), finished }
    },
  }
}

test("/routing -p opens the named profile's layer and saves through the file", async t => {
  const h = setup(t)
  const { editor, options, finished } = await h.open("-p work")
  assert.deepEqual(options, { overlay: true, overlayOptions: { width: "96%", maxHeight: "80%", minWidth: 40, margin: 1 } })
  assert.deepEqual(await h.fire("session_before_reload"), { cancel: true, reason: "the /routing editor is open; the reload runs when it closes" },
    "an open editor holds off OMO's hot reload of omo.jsonc")
  assert.match(screen(editor), /^라우팅 편집 · OMO 9\.9\.9-test · 편집 레이어: profile work \[native\] \(Tab 전환\)/)
  assert.ok(existsSync(h.snapshot), "the first open records the installed builtin as reviewed")
  assert.equal(JSON.parse(readFileSync(h.snapshot, "utf8")).omo, "9.9.9-test")
  select(editor, "quick")
  press(editor, KEY.enter, "a", ..."swe", KEY.enter)
  assert.match(screen(editor), /▸ \(없음\)$/m, "a model without high starts with no effort suffix")
  press(editor, KEY.enter, KEY.esc, "s", "q")
  await finished
  const text = readFileSync(h.cfgPath, "utf8")
  assert.match(text, /\/\/ my routing/)
  assert.deepEqual(parseJsonc(text).profiles.work["[native]"].categories.quick, { models: ["chatgpt-subscription/gpt-mini:low", "devin/swe-2-high"] })
  assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), CONFIG)
  assert.match(h.notes.at(-1).message, /^routing: saved 1 change\(s\) to .*omo\.jsonc \(previous version: .*omo\.jsonc\.bak\); OMO hot-reloads it now that the editor is closed \(\/reload if hot reload is off\)$/)
  assert.equal(await h.fire("session_before_reload"), undefined, "once the editor is closed, reloads proceed")
})

test("/routing refuses outside the TUI and on bad arguments; nothing is written", async t => {
  for (const [options, args, error] of [
    [{ custom: false }, "", /needs the interactive omo TUI/],
    [{ mode: "print" }, "edit", /needs the interactive omo TUI/],
    [{}, "-p nosuch", /no profile "nosuch" in omo\.jsonc \(available profiles: work\)/],
    [{}, "edit --bogus", /"--bogus" is not an option; use \/routing \[--profile <name>\|-p <name>\|--base\]/],
  ]) {
    const h = setup(t, options)
    await h.run(args)
    assert.match(h.notes.at(-1).message, error)
    assert.equal(h.notes.at(-1).kind, "error")
    assert.equal(readFileSync(h.cfgPath, "utf8"), CONFIG)
    assert.ok(!existsSync(h.snapshot))
  }
})

test("a missing omo.jsonc is created on save, and --base edits base alone", async t => {
  const h = setup(t, { config: null })
  assert.ok(!existsSync(h.cfgPath))
  writeFileSync(`${h.cfgPath}.bak`, "an unrelated backup from an older session")
  const { editor, finished } = await h.open("edit --base")
  assert.doesNotMatch(screen(editor), /Tab 전환/)
  select(editor, "deep")
  // s saves from the chain view too; q there steps back to the list, then closes.
  press(editor, KEY.enter, "a", ..."haiku", KEY.enter, KEY.enter, "s")
  assert.deepEqual(parseJsonc(readFileSync(h.cfgPath, "utf8"))["[native]"].categories.deep.models, ["chatgpt-subscription/gpt-big:high", "anthropic-subscription/claude-haiku"])
  press(editor, "d", "s", "q", "q")
  await finished
  assert.deepEqual(parseJsonc(readFileSync(h.cfgPath, "utf8"))["[native]"].categories.deep.models, ["chatgpt-subscription/gpt-big:high"])
  assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), "an unrelated backup from an older session",
    "no file existed before this session, so no save backs anything up over the old .bak")
  assert.match(h.notes.at(-1).message, /^routing: saved 2 change\(s\) to .*omo\.jsonc; OMO hot-reloads it now/, "and the notice cites no backup")
})

test("the editor shows builtin changes since the last review and project configs; c records the review", async t => {
  const h = setup(t, { cwd: undefined })
  const old = { version: 1, omo: "9.9.8", reviewedAt: "2026-09-24T00:00:00.000Z", sections: { categories: { quick: ["old/x"] } } }
  writeFileSync(h.snapshot, JSON.stringify(old))
  const { editor, finished } = await h.open("--base")
  assert.match(screen(editor), /빌트인 변경 \(OMO 9\.9\.8에서 확인한 뒤\): 신규 1 \(deep\) · 변경 1 \(quick\)/)
  assert.deepEqual(JSON.parse(readFileSync(h.snapshot, "utf8")).sections.categories, old.sections.categories,
    "opening records only the sections the snapshot lacked, never a review of the changed one")
  press(editor, "c", "q")
  await finished
  assert.equal(JSON.parse(readFileSync(h.snapshot, "utf8")).omo, "9.9.9-test")

  // A project below home: the walk stops before home's own .omo.
  const q = setup(t, { cwd: home => join(home, "proj", "src") })
  mkdirSync(join(q.home, "proj", ".omo"), { recursive: true })
  writeFileSync(join(q.home, "proj", ".omo", "omo.jsonc"), JSON.stringify({ categories: { quick: { models: ["x/y"] } } }))
  const opened = await q.open("--base")
  const text = screen(opened.editor, 400)
  assert.equal(text.match(/프로젝트 설정 /g)?.length, 1, text)
  assert.match(text, /프로젝트 설정 .*proj[\\/]\.omo[\\/]omo\.jsonc도 라우팅을 정합니다/)
  press(opened.editor, "q")
  await opened.finished
})

test("an unreadable builtin table still opens the editor with configured chains and a warning; the snapshot guesses nothing", async t => {
  const h = setup(t)
  writeFileSync(join(h.home, "omo-ai", "plugin", "extensions", "omo-task.js"), "export const unrelated = {}")
  const { editor, finished } = await h.open("edit --base")
  const text = screen(editor)
  assert.match(text, /⚠ 빌트인 category chains을 읽지 못해 그 노드는 설정된 체인만 보입니다/)
  assert.match(text, /^\s+deep\s+커스텀\s+claude\/claude-opus:H$/m, "configured chains still show")
  assert.doesNotMatch(text, /^\s+quick\s/m, "no builtin category is invented")
  press(editor, "q")
  await finished
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(h.snapshot, "utf8")).sections), ["model_profiles"],
    "only the readable section is recorded as reviewed")
  assert.equal(readFileSync(h.cfgPath, "utf8"), CONFIG)

  // Once readable, the section is recorded silently; a later change is reported.
  const task = join(h.home, "omo-ai", "plugin", "extensions", "omo-task.js")
  writeFileSync(task, TASK)
  const second = await h.open("edit --base")
  assert.doesNotMatch(screen(second.editor), /빌트인 변경 \(/)
  press(second.editor, "q")
  await second.finished
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(h.snapshot, "utf8")).sections).sort(), ["agents", "categories", "model_profiles"])
  writeFileSync(task, TASK.replace('model:"gpt-mini"', 'model:"gpt-new"'))
  const third = await h.open("edit --base")
  assert.match(screen(third.editor), /빌트인 변경 \(OMO 9\.9\.9-test에서 확인한 뒤\): 변경 1 \(quick\)/)
  press(third.editor, "q")
  await third.finished
})

test("a profile named __proto__ is refused, and .bak keeps the file from before the session's first save", async t => {
  const odd = setup(t, { config: `{ "profiles": { "__proto__": { "[native]": {} } } }` })
  await odd.run("edit -p __proto__")
  assert.match(odd.notes.at(-1).message, /a profile named "__proto__" cannot be edited here/)
  assert.equal(({})["[native]"], undefined)

  const h = setup(t)
  const { editor, finished } = await h.open("edit --base")
  select(editor, "deep")
  press(editor, "x", "s", "x", "s", "q")
  await finished
  assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), CONFIG, "the second save did not overwrite the pre-session backup")
  assert.match(h.notes.at(-1).message, /^routing: saved 2 change\(s\)/)
})

test("a bare /routing opens the editor; `edit` is the same command; the hint names only the layer options", async t => {
  const h = setup(t)
  assert.equal(h.hint(), "[--profile <p>|-p <p>|--base]")
  const titles = []
  for (const args of ["", "edit"]) {
    const { editor, finished } = await h.open(args)
    titles.push(screen(editor).split("\n")[0])
    press(editor, "q")
    await finished
  }
  assert.match(titles[0], /편집 레이어: base/)
  assert.equal(titles[1], titles[0])
  assert.equal(readFileSync(h.cfgPath, "utf8"), CONFIG)
})
