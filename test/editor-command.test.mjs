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
  const widgets = {}
  const ctx = {
    mode, cwd: typeof cwd === "function" ? cwd(home) : cwd,
    modelRegistry: { getAvailable: () => MODELS },
    ui: {
      notify: (message, kind) => notes.push({ message, kind }),
      setWidget: (key, content) => {
        if (content === undefined) delete widgets[key]
        else widgets[key] = content({}, {}).render(400).join("\n")
      },
      ...(custom ? {
        custom: (factory, options) => new Promise(done => {
          const editor = factory({ terminal: { rows: 50 }, requestRender() {} }, undefined, undefined, done)
          resolveOpen?.({ editor, options })
        }),
      } : {}),
    },
  }
  createRouting({ registerCommand: (_name, def) => { command = def }, on() {} }, { home, env: { OMO_BIN: join(root, "bin", "omo.js") } })
  return {
    home, cfgPath, notes, widgets,
    snapshot: join(home, ".omo", "routing-builtin-snapshot.json"),
    run: args => command.handler(args, ctx),
    /** Run `/routing <args>` and resolve with the overlay once it is open. */
    open: async args => {
      const opened = new Promise(resolve => { resolveOpen = resolve })
      const finished = command.handler(args, ctx)
      return { ...(await opened), finished }
    },
  }
}

test("/routing edit opens on the named profile, saves through the file and redraws the shown report", async t => {
  const h = setup(t)
  await h.run("work")
  const { editor, options, finished } = await h.open("edit -p work")
  assert.deepEqual(options, { overlay: true, overlayOptions: { width: "96%", maxHeight: "80%", minWidth: 40, margin: 1 } })
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
  assert.match(h.notes.at(-1).message, /^routing: saved 1 change\(s\) to .*omo\.jsonc \(previous version: .*omo\.jsonc\.bak\); \/reload to apply$/)
  assert.match(h.widgets.routing, /^quick .*codex\/gpt-mini:L → devin\/swe-2-high \[configured\]/m, "the shown report is redrawn from the saved file")
})

test("/routing edit refuses outside the TUI and on bad arguments; nothing is written", async t => {
  for (const [options, args, error] of [
    [{ custom: false }, "edit", /needs the interactive omo TUI/],
    [{ mode: "print" }, "edit", /needs the interactive omo TUI/],
    [{}, "edit -p nosuch", /no profile "nosuch" in omo\.jsonc \(available profiles: work\)/],
    [{}, "edit --bogus", /"--bogus" is not an option for \/routing edit/],
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
  const { editor, finished } = await h.open("edit --base")
  assert.doesNotMatch(screen(editor), /Tab 전환/)
  select(editor, "deep")
  // s saves from the chain view too; q there steps back to the list, then closes.
  press(editor, KEY.enter, "a", ..."haiku", KEY.enter, KEY.enter, "s", "q", "q")
  await finished
  assert.deepEqual(parseJsonc(readFileSync(h.cfgPath, "utf8"))["[native]"].categories.deep.models, ["chatgpt-subscription/gpt-big:high", "anthropic-subscription/claude-haiku"])
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
  assert.match(h.notes.at(-1).message, /^routing: saved 1 change\(s\) to .*omo\.jsonc; \/reload to apply$/)
})

test("reports show builtin changes since the last review and project configs, and never write the snapshot", async t => {
  const h = setup(t, { cwd: undefined })
  await h.run("base")
  assert.doesNotMatch(h.widgets.routing, /builtin changes since last review/)
  assert.ok(!existsSync(h.snapshot), "a report never records a review")
  const old = { version: 1, omo: "9.9.8", reviewedAt: "2026-09-24T00:00:00.000Z", sections: { categories: { quick: ["old/x"] } } }
  writeFileSync(h.snapshot, JSON.stringify(old))
  await h.run("base")
  assert.match(h.widgets.routing, /^builtin changes since last review \(reviewed on OMO 9\.9\.8\): new 1 \(deep\), changed 1 \(quick\); \/routing edit to review$/m)
  assert.deepEqual(JSON.parse(readFileSync(h.snapshot, "utf8")), old)

  const { editor, finished } = await h.open("edit")
  assert.match(screen(editor), /빌트인 변경 \(OMO 9\.9\.8에서 확인한 뒤\): 신규 1 \(deep\) · 변경 1 \(quick\)/)
  press(editor, "c", "q")
  await finished
  assert.equal(JSON.parse(readFileSync(h.snapshot, "utf8")).omo, "9.9.9-test")
  await h.run("base")
  assert.doesNotMatch(h.widgets.routing, /builtin changes since last review/)

  // A project below home: the walk stops before home's own .omo.
  const q = setup(t, { cwd: home => join(home, "proj", "src") })
  mkdirSync(join(q.home, "proj", ".omo"), { recursive: true })
  writeFileSync(join(q.home, "proj", ".omo", "omo.jsonc"), JSON.stringify({ categories: { quick: { models: ["x/y"] } } }))
  await q.run("base")
  const notices = q.widgets.routing.split("\n").filter(line => line.startsWith("warning: project config"))
  assert.deepEqual(notices.length, 1, q.widgets.routing)
  assert.match(notices[0], /proj[\\/]\.omo[\\/]omo\.jsonc also sets routing; OMO merges it over ~\/\.omo\/omo\.jsonc in sessions started under /)
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
})

test("/routing help lists the edit form and the hint names it", async t => {
  const h = setup(t)
  await h.run("help")
  assert.match(h.widgets.routing, /^\/routing edit \[--profile <p>\|-p <p>\|--base\]/m)
})
