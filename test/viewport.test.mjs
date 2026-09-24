import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createRouting, widgetFactory } from "../extension/routing.ts"
import { fixtureDir } from "./fixture-dir.mjs"

const providers = ["claude-sdk-oauth", "github-copilot", "amazon-bedrock", "google-vertex-anthropic"]
const model = "claude-a-very-long-model-identifier-20260919:max"
const rung = "{claude|gh|amazon-bedrock|google-vertex-anthropic}/claude-a-very-long-model-identifier-20260919:X"
const compact = text => text.replace(/\s/gu, "")

// Exercise the factory registered by the real command, not a prewrapped string array.
test("routing widget render fits builtin rungs, model IDs, sources, paths and fallbacks on resize", async t => {
  const home = fixtureDir("routing-viewport-")
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const extensions = join(home, "installed-omo-with-a-long-directory-name", "plugin", "extensions")
  mkdirSync(extensions, { recursive: true })
  mkdirSync(join(home, ".omo"))
  const chain = JSON.stringify([{ providers, model: model.split(":")[0], variant: "max" }]).replaceAll('"providers":', 'providers:')
  writeFileSync(join(extensions, "omo-task.js"), `const cats={deep:${chain},quick:${chain}};const agents={explore:${chain},librarian:${chain}};`)
  writeFileSync(join(extensions, "omo.js"), `const profiles={capable:{displayName:"Capable",models:${chain}},"deep-work":{displayName:"Deep",models:${chain}}};`)
  writeFileSync(join(home, ".omo", "omo.jsonc"), JSON.stringify({
    model_profile: "capable",
    categories: { "a-category-name-longer-than-a-narrow-viewport": { models: [`custom/${model}`] } },
    agents: { explore: { models: [`custom/${model}`] } },
  }))
  let command
  let component
  let report
  createRouting({ registerCommand: (_name, value) => { command = value } }, {
    home, env: { OMO_BIN: join(extensions, "..", "..", "bin", "omo.js") },
  })
  await command.handler("base", { ui: { notify: message => { report = message } } })
  await command.handler("base", { ui: {
    setWidget: (_name, factory) => { component = factory({}, {}) },
    notify: message => assert.fail(message),
  } })
  assert.ok(report.includes(rung), "fixture reaches installed provider-alternative discovery")
  const original = component.render(10000)
  assert.equal(original.slice(0, -2).join("\n"), report)
  // A table reflows its cells when it wraps, so the reading order is width
  // dependent; the data must not be.
  // Escapes from a one-cell viewport are decoded back before comparing.
  const inventory = lines => [...compact(lines.join(""))
    .replace(/\\u\{([0-9a-f]+)\}/gu, (_, code) => String.fromCodePoint(parseInt(code, 16)))].sort().join("")
  for (const width of [120, 80, 40, 24, 12, 4, 2, 1, 160]) {
    const rendered = component.render(width)
    assert.ok(rendered.every(line => [...line].length <= width),
      `render(${width}) overflow: ${JSON.stringify(rendered.find(line => [...line].length > width))}`)
    assert.equal(inventory(rendered), inventory(original), `render(${width}) preserves all data`)
    // A name longer than the name column wraps inside it, so check the short ones.
    if (width >= 40) for (const name of ["main (capable)", "deep", "quick", "explore", "librarian"]) {
      assert.ok(rendered.some(line => line.startsWith(name)), `render(${width}) dropped the ${name} row`)
    }
  }
  assert.deepEqual(component.render(10000), original, "narrow rendering does not mutate the report")
})

test("widget keeps CJK, combining marks and emoji graphemes intact while counting terminal cells", () => {
  // Independent fixture width oracle: these exact graphemes have known cell widths.
  const wide = new Set(["한", "글", "模", "型", "界", "😀", "👩‍💻", "🇰🇷", "１"])
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const cells = text => [...segmenter.segment(text)].reduce((sum, { segment }) => sum + (wide.has(segment) ? 2 : 1), 0)
  const lines = ["한글      provider/模型界😀👩‍💻🇰🇷１:e\u0301 → next/model  [configured]", "user config: C:/한글/模型/e\u0301/😀/omo.jsonc"]
  const widget = widgetFactory(lines)({}, {})
  for (const width of [2, 3, 4, 8, 16, 32, 80]) {
    const rendered = widget.render(width)
    assert.ok(rendered.every(line => cells(line) <= width), `render(${width}) overflows terminal cells`)
    assert.equal(compact(rendered.join("")), compact(lines.join("")))
    const originalClusters = [...segmenter.segment(compact(lines.join("")))].map(x => x.segment)
    const renderedClusters = rendered.flatMap(line => [...segmenter.segment(compact(line))].map(x => x.segment))
    assert.deepEqual(renderedClusters, originalClusters, "wrapping must not split graphemes")
  }
})

test("a one-cell viewport displays a wide glyph as a lossless Unicode escape", () => {
  const rendered = widgetFactory(["界"] )({}, {}).render(1)
  assert.ok(rendered.every(line => line.length <= 1))
  assert.equal(rendered.join(""), "\\u{754c}")
})

test("widget retains chain alignment when it fits and leaves short lines unchanged", () => {
  const row = "deep      a/b:max → c/d:high → e/f:low"
  const widget = widgetFactory([row, ""])({}, {})
  assert.deepEqual(widget.render(24), ["deep      a/b:max →", "          c/d:high →", "          e/f:low", ""])
  assert.deepEqual(widget.render(100), [row, ""])
  assert.deepEqual(widget.render(0), [row, ""])
})
