import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouting } from "../extension/routing.ts"
import { fixtureDir } from "./fixture-dir.mjs"

// Data-only extracts shaped like the installed OMO bundles: chain tables plus the
// category/agent/profile definitions that carry the builtin role descriptions.
const TASK_SOURCE = [
  `var cats={quick:[{providers:["one","two"],model:"fast",variant:"low"}],deep:[{providers:["three"],model:"smart",variant:"high"}]};`,
  `var subs={explore:[{providers:["four"],model:"search"}],librarian:[{providers:["five"],model:"docs"}]};`,
  `var defs=[{name:"quick",config:{model:"primary/fast",variant:"max"},description:"Small one-file edits. Never used for large refactors.",promptAppend:"ignored"},`,
  `{name:"deep",config:{model:"primary/smart",variant:"high"},description:"복잡한 조사와 시각 QA를 담당합니다."}];`,
  `var agents=[{name:"explore",description:'Contextual grep. Answers "Where is X?"',mode:"subagent",executionMode:"in-process",prompt:"never executed"},`,
  `{name:"reviewer",description:"Reviews diffs before approval.",mode:"subagent",executionMode:"in-process",categories:["deep"],prompt:"never executed"}];`,
  `throw new Error("must never execute installed source");`,
].join("")
const MAIN_SOURCE = `var profiles={capable:{displayName:"Capable",description:"Strongest generalist.",models:[{providers:["six","seven"],model:"main",variant:"max"}]},"deep-work":{displayName:"Deep",description:"Hard problems.",models:[{providers:["eight"],model:"reason"}]}};throw new Error("must never execute installed source");`

function fixture(t, config, { builtins = true } = {}) {
  const home = builtins ? fixtureDir("routing-table-") : mkdtempSync(join(tmpdir(), "routing-table-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const extensions = join(home, "installed omo", "plugin", "extensions")
  mkdirSync(extensions, { recursive: true })
  mkdirSync(join(home, ".omo"))
  writeFileSync(join(extensions, "omo-task.js"), TASK_SOURCE)
  writeFileSync(join(extensions, "omo.js"), MAIN_SOURCE)
  writeFileSync(join(home, ".omo", "omo.jsonc"), JSON.stringify(config))
  let command
  let component
  createRouting({ registerCommand: (_name, value) => { command = value } }, {
    home, env: builtins ? { OMO_BIN: join(home, "installed omo", "bin", "omo.js") } : {},
  })
  const ctx = { ui: {
    setWidget: (_name, factory) => { component = factory({}, {}) },
    notify: message => assert.fail(message),
  } }
  return { run: (args = "base") => command.handler(args, ctx), render: (width = 10000) => component.render(width) }
}

// Independent cell-width oracle: Hangul syllables and CJK occupy two terminal cells.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u
const cells = text => [...segmenter.segment(text)].reduce((sum, { segment }) => sum + (wide.test(segment) ? 2 : 1), 0)
// Wrapping a table reflows cells across lines, so the reading order changes with
// the viewport; what must never change is the data itself. Unicode escapes from a
// one-cell viewport are decoded back before comparing.
const inventory = lines => [...lines.join("")
  .replace(/\\u\{([0-9a-f]+)\}/gu, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/\s/gu, "")].sort().join("")

const HEADERS = ["카테고리명", "설명", "라우팅", "변경여부"]

function row(lines, name) {
  const line = lines.find(line => line.startsWith(name + "  "))
  assert.ok(line, `missing row: ${name}\n${lines.join("\n")}`)
  const parts = line.trim().split(/\s{2,}/)
  assert.equal(parts.length, 4, `row "${name}" is not four columns: ${line}`)
  return { name: parts[0], description: parts[1], routing: parts[2], status: parts[3] }
}

const chainOfRow = cell => cell.replace(/\s+\[[^\]]*\]$/, "")
const sourceOfRow = cell => cell.match(/\[([^\]]*)\]$/)?.[1]

test("the report keeps its metadata and renders the four approved columns in order", async t => {
  const h = fixture(t, { model_profile: "capable", categories: { quick: { models: ["custom/one"] } } })
  await h.run()
  const lines = h.render()
  const text = lines.join("\n")
  assert.match(text, /^config profile: base .*available profiles: none defined$/m)
  assert.match(text, /^main model chain \(model_profile\): capable$/m)
  assert.match(text, /^user config: .*omo\.jsonc$/m)
  assert.match(text, /^builtin defaults: .*installed omo/m)

  const header = lines.find(line => line.startsWith(HEADERS[0]))
  assert.ok(header, "column header row is missing")
  assert.deepEqual(header.trim().split(/\s{2,}/), HEADERS)
  const order = ["main:", "categories:", "agents:"].map(label => lines.indexOf(label))
  assert.ok(order.every(index => index > lines.indexOf(header)), "sections follow the header")
  assert.deepEqual([...order].sort((a, b) => a - b), order, "main, categories and agents keep their order")
  assert.ok(lines.indexOf("main:") > 0 && order.every(index => index > 0), "main/categories/agents sections are retained")
})

test("변경여부 compares effective routing with builtin routing, not the presence of user config", async t => {
  const h = fixture(t, {
    categories: {
      // same canonical chain the builtin resolves to: routing is unchanged
      deep: { models: ["primary/smart:high", "three/smart:high"] },
      // description-only override: routing is still the builtin one
      quick: { description: "우리 팀 전용 설명" },
      // a genuinely different chain
      writing: { models: ["custom/writer"] },
    },
  })
  await h.run()
  const lines = h.render()
  assert.equal(row(lines, "deep").status, "기본")
  assert.equal(row(lines, "quick").status, "기본")
  assert.equal(row(lines, "quick").description, "우리 팀 전용 설명")
  assert.equal(row(lines, "writing").status, "변경")
  assert.equal(chainOfRow(row(lines, "writing").routing), "custom/writer")
})

test("builtin role descriptions fill the 설명 column when the config does not", async t => {
  const h = fixture(t, {})
  await h.run()
  const lines = h.render()
  assert.equal(row(lines, "deep").description, "복잡한 조사와 시각 QA를 담당합니다.")
  assert.match(row(lines, "quick").description, /^Small one-file edits/)
  assert.match(row(lines, "explore").description, /^Contextual grep/)
  assert.equal(row(lines, "reviewer").description, "Reviews diffs before approval.")
  assert.equal(row(lines, "librarian").description, "-", "no builtin description is invented")
  assert.equal(chainOfRow(row(lines, "quick").routing), "primary/fast:X → {one|two}/fast:L",
    "builtin primary precedes the fallback table")
  assert.equal(sourceOfRow(row(lines, "deep").routing), "builtin", "chain source information is preserved")
})

test("disabled, inherited and fallback behaviour drive 변경여부", async t => {
  const h = fixture(t, {
    categories: { deep: { models: ["custom/reason"] } },
    agents: { explore: { disable: true }, librarian: { models: ["five/docs"] } },
  })
  await h.run()
  const lines = h.render()
  assert.equal(row(lines, "deep").status, "변경")
  // reviewer has no config of its own, but inherits the changed `deep` category
  assert.equal(row(lines, "reviewer").status, "변경")
  assert.equal(chainOfRow(row(lines, "reviewer").routing), "custom/reason")
  assert.equal(row(lines, "explore").status, "변경")
  assert.equal(row(lines, "explore").routing, "(disabled)")
  // configured with exactly the builtin chain: effective routing is the default one
  assert.equal(row(lines, "librarian").status, "기본")
})

test("an agent configured with its builtin chain keeps its separate builtin fallback branch", async t => {
  const h = fixture(t, { agents: { reviewer: { models: ["custom/only"] } } })
  await h.run()
  const lines = h.render()
  const index = lines.findIndex(line => line.startsWith("reviewer  "))
  assert.equal(row(lines, "reviewer").status, "변경")
  const fallback = lines[index + 1]
  assert.match(fallback, /builtin fallback: primary\/smart:H → three\/smart:H/)
  assert.ok(/^\s/.test(fallback), "the fallback branch stays inside the 라우팅 column")
})

test("main rows report the selected chain against the builtin profile", async t => {
  const unchanged = fixture(t, { model_profile: "capable" })
  await unchanged.run()
  const main = row(unchanged.render(), "main (capable)")
  assert.equal(main.status, "기본")
  assert.equal(main.description, "Strongest generalist.")
  assert.equal(chainOfRow(main.routing), "{six|seven}/main:X")

  const replaced = fixture(t, { model_profile: "capable", model_profiles: { capable: { models: ["custom/main"] } } })
  await replaced.run()
  assert.equal(row(replaced.render(), "main (capable)").status, "변경")

  const pinned = fixture(t, { model_profile: "pin/model:high" })
  await pinned.run()
  assert.equal(row(pinned.render(), "main (pin/model:high)").status, "변경")
})

test("확인 불가 is shown for every row when builtin routing cannot be read", async t => {
  const h = fixture(t, { model_profile: "custom", model_profiles: { custom: { models: ["a/b"] } }, categories: { quick: { models: ["a/b"] } } }, { builtins: false })
  await h.run()
  const lines = h.render()
  assert.match(lines.join("\n"), /^warning: builtin defaults unavailable/m)
  assert.equal(row(lines, "quick").status, "확인 불가")
  assert.equal(row(lines, "main (custom)").status, "확인 불가")
})

test("long cells wrap inside the table, aligned to their column", async t => {
  const h = fixture(t, { categories: { quick: { description: "A deliberately long configured description that must wrap inside its own column instead of pushing the routing column out of the viewport." } } })
  await h.run()
  const lines = h.render(100)
  const header = lines.find(line => line.startsWith(HEADERS[0]))
  const descriptionColumn = cells(header.slice(0, header.indexOf(HEADERS[1])))
  const index = lines.findIndex(line => line.startsWith("quick  "))
  const continuation = lines[index + 1]
  assert.ok(continuation.startsWith(" ".repeat(descriptionColumn)), `continuation is not aligned: ${JSON.stringify(continuation)}`)
  assert.ok(lines.every(line => cells(line) <= 100), "wrapped table overflows the viewport")
})

test("the table stays lossless and inside the viewport at wide and narrow widths, breaking provider groups at |", async t => {
  const h = fixture(t, {
    model_profile: "capable",
    categories: { quick: { description: "한글 설명이 포함된 카테고리입니다." } },
    agents: { librarian: { models: ["custom/librarian-with-a-very-long-model-identifier:max"] } },
  })
  await h.run()
  const original = h.render()
  const names = ["main (capable)", "deep", "quick", "explore", "librarian", "reviewer"]
  for (const width of [160, 120, 80, 60, 40, 24, 12, 4, 2, 1]) {
    const rendered = h.render(width)
    assert.ok(rendered.every(line => cells(line) <= width),
      `render(${width}) overflow: ${JSON.stringify(rendered.find(line => cells(line) > width))}`)
    assert.equal(inventory(rendered), inventory(original), `render(${width}) lost data`)
    if (width >= 24) for (const name of names) {
      assert.ok(rendered.some(line => line.startsWith(name)), `render(${width}) dropped the ${name} row`)
    }
  }
  assert.ok(h.render(12).some(line => line.endsWith("|")), "provider groups break at | when narrow")
  assert.deepEqual(h.render(), original, "narrow rendering does not mutate the report")
})
