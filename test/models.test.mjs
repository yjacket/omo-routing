// `/routing models`: enabled categories grouped by canonical model+effort at each
// candidate position. Fake pi/ctx harness only; no senpi, no LLM, no writes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouting } from "../extension/routing.ts"

// Data-only extracts shaped like the installed OMO bundles.
const TASK_SOURCE = [
  `var cats={quick:[{providers:["one","two"],model:"fast",variant:"low"}],deep:[{providers:["three"],model:"smart",variant:"high"}]};`,
  `var subs={explore:[{providers:["four"],model:"search"}],librarian:[{providers:["five"],model:"docs"}]};`,
  `var defs=[{name:"quick",config:{model:"primary/fast",variant:"max"},description:"Small edits."},`,
  `{name:"deep",config:{model:"primary/smart",variant:"high"},description:"Deep work."}];`,
  `var agents=[{name:"explore",description:"Contextual grep.",mode:"subagent",executionMode:"in-process",prompt:"never executed"}];`,
  `throw new Error("must never execute installed source");`,
].join("")
const MAIN_SOURCE = `var profiles={capable:{displayName:"Capable",description:"General.",models:[{providers:["six","seven"],model:"main",variant:"max"}]},"deep-work":{displayName:"Deep",description:"Hard.",models:[{providers:["eight"],model:"reason"}]}};throw new Error("must never execute installed source");`

// architect/writing share gpt-5.6-sol:high at 1차 through different providers;
// architect repeats it at 2차; 3차 holds `off` and `none`, which look alike but
// are different canonical efforts.
const CONFIG = {
  model_profile: "capable",
  categories: {
    architect: { models: ["openai-codex/gpt-5.6-sol:high", "github-copilot/gpt-5.6-sol:high", "devin/swe-2-high:off"] },
    writing: { models: ["claude-sdk-oauth/gpt-5.6-sol:high", "devin/swe-2-high:max", "devin/swe-2-high:none"] },
    silent: { disable: true },
  },
  agents: { explore: { models: ["agent-only/agent-model:max"] } },
  profiles: { capacity: { "[senpi]": { categories: { architect: { models: ["profile-provider/profile-model:low"] } } } } },
}

function fixture(t, config = CONFIG, { builtins = true, env = {}, widget = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "routing-models-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const extensions = join(home, "installed omo", "plugin", "extensions")
  mkdirSync(extensions, { recursive: true })
  mkdirSync(join(home, ".omo"))
  writeFileSync(join(extensions, "omo-task.js"), TASK_SOURCE)
  writeFileSync(join(extensions, "omo.js"), MAIN_SOURCE)
  const configPath = join(home, ".omo", "omo.jsonc")
  const source = JSON.stringify(config)
  writeFileSync(configPath, source)
  let command
  let component
  const notes = []
  createRouting({ registerCommand: (_name, value) => { command = value } }, {
    home, env: { ...env, ...(builtins ? { OMO_BIN: join(home, "installed omo", "bin", "omo.js") } : {}) },
  })
  const ui = { notify: (message, kind) => notes.push({ message, kind }) }
  if (widget) ui.setWidget = (_name, factory) => { component = factory === undefined ? undefined : factory({}, {}) }
  const ctx = { ui, modelRegistry: { getAvailable: () => assert.fail("provider checks are out of scope") } }
  return {
    notes,
    run: (args = "models") => command.handler(args, ctx),
    render: (width = 10000) => component.render(width),
    hidden: () => component === undefined,
    unchanged: () => assert.equal(readFileSync(configPath, "utf8"), source, "the models view must never write"),
  }
}

const HEADERS = ["모델", "프로바이더", "담당 카테고리"]

// Section -> rows of [모델, 프로바이더, 담당 카테고리]. Reads the laid-out table,
// not prose, and only at a width where no cell wraps.
function sections(lines) {
  const out = new Map()
  let current
  for (const line of lines) {
    const label = line.match(/^(\d+)차:$/)
    if (label) { current = []; out.set(Number(label[1]), current); continue }
    if (!current) continue
    if (!line.trim()) { current = undefined; continue }
    const cells = line.trim().split(/\s{2,}/)
    assert.equal(cells.length, 3, `row is not three columns: ${line}`)
    current.push(cells)
  }
  return out
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u
const cells = text => [...segmenter.segment(text)].reduce((sum, { segment }) => sum + (wide.test(segment) ? 2 : 1), 0)
const inventory = lines => [...lines.join("")
  .replace(/\\u\{([0-9a-f]+)\}/gu, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/\s/gu, "")].sort().join("")

test("models view groups enabled categories by model and effort at each candidate position", async t => {
  const h = fixture(t)
  await h.run("models --base")
  const lines = h.render()
  const header = lines.find(line => line.startsWith(HEADERS[0]))
  assert.ok(header, `column header row is missing:\n${lines.join("\n")}`)
  assert.deepEqual(header.trim().split(/\s{2,}/), HEADERS)
  const grouped = sections(lines)
  assert.deepEqual([...grouped.keys()], [1, 2, 3], "one section per candidate position, in order")
  assert.deepEqual(grouped.get(1), [
    // one row per model+effort; providers of the same model+effort aggregate
    ["gpt-5.6-sol:H", "codex, claude", "architect, writing"],
    ["smart:H", "primary", "deep"],
    ["fast:X", "primary", "quick"],
  ])
  assert.deepEqual(grouped.get(2), [
    ["gpt-5.6-sol:H", "gh", "architect"],
    ["smart:H", "three", "deep"],
    // a builtin {one|two} rung is one position, not two
    ["fast:L", "one, two", "quick"],
    ["swe-2-high:X", "devin", "writing"],
  ])
  assert.deepEqual(grouped.get(3), [
    // off and none share a display letter but are never merged
    ["swe-2-high:O", "devin", "architect"],
    ["swe-2-high:O", "devin", "writing"],
  ])
  h.unchanged()
})

test("models view covers categories only: no agents, no main, no disabled entries", async t => {
  const h = fixture(t)
  await h.run("models --base")
  const lines = h.render()
  const table = [...sections(lines).values()].flat().flat().join(" ")
  for (const absent of ["agent-only", "agent-model", "explore", "librarian", "search", "docs", "main", "silent"])
    assert.ok(!table.includes(absent), `${absent} must not appear in the models table: ${table}`)
  assert.ok(!lines.some(line => line.startsWith("silent")), "a disabled category has no row")
})

test("models view keeps the report metadata, warnings and the widget hint", async t => {
  const h = fixture(t, CONFIG, { env: { OMO_PROFILE: "gone" } })
  await h.run("models")
  const lines = h.render()
  const text = lines.join("\n")
  assert.match(text, /^config profile: base .*available profiles: capacity$/m)
  assert.match(text, /^user config: .*omo\.jsonc$/m)
  assert.match(text, /^builtin defaults: .*installed omo/m)
  assert.match(text, /^warning: profile "gone" does not exist/m)
  assert.equal(lines.at(-1), "(/routing again or /routing off to hide)")
  assert.equal(h.notes.length, 0, "widget hosts get no toast")
})

test("models view warns instead of inventing builtin positions when the installed source is unreadable", async t => {
  const h = fixture(t, { categories: { only: { models: ["a/b:high"] } } }, { builtins: false })
  await h.run("models")
  const lines = h.render()
  assert.match(lines.join("\n"), /^warning: builtin defaults unavailable/m)
  assert.deepEqual(sections(lines).get(1), [["b:H", "a", "only"]])
  assert.equal(sections(lines).get(2), undefined)
})

test("models view states plainly when there is nothing enabled to group", async t => {
  const h = fixture(t, { categories: { only: { disable: true } } }, { builtins: false })
  await h.run("models")
  assert.match(h.render().join("\n"), /no enabled categories/)
  assert.equal(sections(h.render()).size, 0)
})

test("models view uses the current profile and honours --profile/-p/--base without switching or writing", async t => {
  const env = { OMO_PROFILE: "capacity" }
  const current = fixture(t, CONFIG, { env })
  await current.run("models")
  assert.match(current.render().join("\n"), /^config profile: capacity /m)
  assert.deepEqual(sections(current.render()).get(1)[0], ["profile-model:L", "profile-provider", "architect"])
  current.unchanged()

  const base = fixture(t, CONFIG, { env })
  await base.run("models --base")
  assert.match(base.render().join("\n"), /^config profile: base /m)
  assert.deepEqual(sections(base.render()).get(1)[0], ["gpt-5.6-sol:H", "codex, claude", "architect, writing"])

  for (const flag of ["--profile capacity", "-p capacity"]) {
    const named = fixture(t)
    await named.run(`models ${flag}`)
    assert.match(named.render().join("\n"), /^config profile: capacity /m)
    assert.deepEqual(sections(named.render()).get(1)[0], ["profile-model:L", "profile-provider", "architect"])
    named.unchanged()
  }
})

test("models view rejects unknown arguments and unknown profiles, pointing at help", async t => {
  const h = fixture(t)
  for (const args of ["models capacity", "models --wat", "models -p"]) {
    await h.run(args)
    assert.equal(h.notes.at(-1).kind, "error", `${args} must be an error`)
    assert.match(h.notes.at(-1).message, /\/routing help/)
    assert.ok(h.hidden(), `${args} must not render a table`)
  }
  await h.run("models --profile nope")
  assert.equal(h.notes.at(-1).kind, "error")
  assert.match(h.notes.at(-1).message, /no profile "nope".*available profiles: capacity/)
  h.unchanged()
})

test("/routing help lists the models form and the command hint mentions it", async t => {
  const h = fixture(t, CONFIG, { widget: false })
  await h.run("help")
  assert.match(h.notes.at(-1).message, /^\/routing models\b/m)
  const hint = fixture(t)
  await hint.run("models --base")
  assert.ok(hint.render().length > 0)
})

test("models view toggles with the widget and falls back to a toast without one", async t => {
  const h = fixture(t)
  await h.run("models")
  assert.ok(!h.hidden())
  await h.run("models")
  assert.ok(!h.hidden(), "an explicit models request always shows, never toggles")
  await h.run("")
  assert.ok(h.hidden(), "a bare /routing hides the models view like any other report")
  await h.run("models --base")
  assert.ok(!h.hidden())
  await h.run("off")
  assert.ok(h.hidden())

  const toast = fixture(t, CONFIG, { widget: false })
  await toast.run("models --base")
  assert.equal(toast.notes.at(-1).kind, "info")
  assert.match(toast.notes.at(-1).message, /^1차:$/m)
  assert.match(toast.notes.at(-1).message, /gpt-5\.6-sol:H/)
})

test("the models table stays lossless and inside the viewport at every width", async t => {
  const h = fixture(t, {
    ...CONFIG,
    categories: { ...CONFIG.categories, "한글-카테고리": { models: ["claude-sdk-oauth/a-very-long-model-identifier-20260919:max"] } },
  })
  await h.run("models --base")
  const original = h.render()
  for (const width of [160, 120, 80, 60, 40, 24, 12, 4, 2, 1]) {
    const rendered = h.render(width)
    assert.ok(rendered.every(line => cells(line) <= width),
      `render(${width}) overflow: ${JSON.stringify(rendered.find(line => cells(line) > width))}`)
    assert.equal(inventory(rendered), inventory(original), `render(${width}) lost data`)
    if (width >= 40) assert.ok(rendered.some(line => line.startsWith("1차:")), `render(${width}) dropped the 1차 section`)
  }
  assert.deepEqual(h.render(), original, "narrow rendering does not mutate the report")
})
