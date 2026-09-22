import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouting } from "../extension/routing.ts"

// Real command + widget factory, with both config and installed bundles isolated.
function fixture(t, config) {
  const home = mkdtempSync(join(tmpdir(), "routing-labels-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const extensions = join(home, "plugin", "extensions")
  mkdirSync(extensions, { recursive: true })
  mkdirSync(join(home, ".omo"))
  const configPath = join(home, ".omo", "omo.jsonc")
  writeFileSync(configPath, JSON.stringify(config))
  const chain = '[{providers:["openai-codex","github-copilot","future-provider"],model:"swe-2-high",variant:"high"}]'
  writeFileSync(join(extensions, "omo-task.js"), `const cats={deep:${chain},quick:${chain}};const agents={explore:${chain},librarian:${chain}};const inherited={name:"reviewer",categories:["deep"]};`)
  writeFileSync(join(extensions, "omo.js"), `const profiles={capable:{displayName:"Capable",models:${chain}},"deep-work":{displayName:"Deep",models:${chain}}};`)
  let command
  let component
  createRouting({ registerCommand: (_name, value) => { command = value } }, {
    home, env: { OMO_BIN: join(home, "bin", "omo.js") },
  })
  const ctx = { ui: {
    setWidget: (_name, factory) => { component = factory({}, {}) },
    notify: message => assert.fail(message),
  } }
  return {
    run: (args = "base") => command.handler(args, ctx),
    render: (width = 10000) => component.render(width),
    readConfig: () => JSON.parse(readFileSync(configPath, "utf8")),
  }
}

// The 라우팅 cell of a table row, split into its rungs; the source tag and the
// other columns are checked separately where they matter.
function row(lines, name) {
  const line = lines.find(line => line.startsWith(name + "  "))
  assert.ok(line, `missing row: ${name}`)
  const cells = line.trim().split(/\s{2,}/)
  assert.equal(cells.length, 4, `row "${name}" is not four columns: ${line}`)
  return cells[2].replace(/\s+\[[^\]]*\]$/, "").split(" → ")
}

const canonical = [
  "openai-codex/gpt-5.6-sol:max", "claude-sdk-oauth/claude-fable-5-1:xhigh",
  "github-copilot/gpt-6-astra:high", "devin/swe-2-high:medium",
  "openai-codex/gpt-5.6-terra:low", "openai-codex/gpt-5.6-terra:off",
  "openai-codex/gpt-5.6-terra:minimal", "openai-codex/gpt-5.6-terra:auto",
  "openai-codex/gpt-5.6-terra:none",
]
const labels = [
  "codex/gpt-5.6-sol:X", "claude/claude-fable-5-1:E",
  "gh/gpt-6-astra:H", "devin/swe-2-high:M",
  "codex/gpt-5.6-terra:L", "codex/gpt-5.6-terra:O",
  "codex/gpt-5.6-terra:mi", "codex/gpt-5.6-terra:au",
  "codex/gpt-5.6-terra:O",
]

for (const [name, config] of [
  ["main (custom)", { model_profile: "custom", model_profiles: { custom: { models: canonical } } }],
  ["custom", { categories: { custom: { models: canonical } } }],
  ["custom", { agents: { custom: { models: canonical } } }],
]) {
  test(`compact aliases in ${Object.keys(config)[0]} rows preserve model IDs`, async t => {
    const h = fixture(t, config)
    await h.run()
    assert.deepEqual(row(h.render(), name), labels)
    assert.deepEqual(h.readConfig(), config, "display must never write aliases")
  })
}

test("effort suffixes shorten without rewriting high/max text inside model identifiers", async t => {
  const h = fixture(t, { categories: { custom: { models: [
    "devin/swe-2-high", "devin/swe-2-high:high", "devin/swe-2-max",
    "openai-codex/claude-sdk-oauth-github-copilot-high:max", "openai-codex/model:revision:high",
  ] } } })
  await h.run()
  assert.deepEqual(row(h.render(), "custom"), [
    "devin/swe-2-high", "devin/swe-2-high:H", "devin/swe-2-max",
    "codex/claude-sdk-oauth-github-copilot-high:X", "codex/model:revision:H",
  ])
})

test("OMO reasoning fields display efforts and survive canonical chain edits", async t => {
  const h = fixture(t, { categories: { custom: { models: [
    { model: "claude-sdk-oauth/claude-fable-5-1", reasoning: "medium" },
    { model: "claude-sdk-oauth/claude-sonnet-5", reasoning: "medium" },
    "devin/swe-2-high",
  ] } } })
  await h.run()
  assert.deepEqual(row(h.render(), "custom"), [
    "claude/claude-fable-5-1:M", "claude/claude-sonnet-5:M", "devin/swe-2-high",
  ])
  await h.run("add custom github-copilot/claude-sonnet-5:medium")
  assert.deepEqual(h.readConfig().categories.custom.models, [
    "claude-sdk-oauth/claude-fable-5-1:medium", "claude-sdk-oauth/claude-sonnet-5:medium",
    "devin/swe-2-high", "github-copilot/claude-sonnet-5:medium",
  ])
})

test("unknown provider and effort values remain readable, with no prefix guessing", async t => {
  const h = fixture(t, { categories: { custom: { models: [
    "future-provider/swe-2-high:future-effort", "openai-codex-proxy/model:high",
    "openai-codex/model:maximum", "constructor/model:constructor", "__proto__/model:__proto__",
    "github-copilot/model:HIGH", "anthropic/model:high",
  ] } } })
  await h.run()
  assert.deepEqual(row(h.render(), "custom"), [
    "future-provider/swe-2-high:future-effort", "openai-codex-proxy/model:H",
    "codex/model:maximum", "constructor/model:constructor", "__proto__/model:__proto__",
    "gh/model:HIGH", "anthropic/model:H",
  ])
})

test("builtin main, category, inherited agent, and separate fallback retain provider groups", async t => {
  const h = fixture(t, { model_profile: "capable", agents: { explore: { models: ["claude-sdk-oauth/swe-2-high:high"] } } })
  await h.run()
  const lines = h.render()
  const grouped = "{codex|gh|future-provider}/swe-2-high:H"
  for (const name of ["main (capable)", "deep", "quick", "reviewer", "librarian"]) {
    assert.deepEqual(row(lines, name), [grouped])
  }
  assert.deepEqual(row(lines, "explore"), ["claude/swe-2-high:H"])
  // The separate builtin branch stays in the explore row's 라우팅 column.
  const fallback = lines[lines.findIndex(line => line.startsWith("explore  ")) + 1]
  assert.match(fallback, /^\s+builtin fallback: /)
  assert.equal(fallback.trim().split(": ")[1], grouped)
})

test("direct main pins display compactly without changing the canonical selection", async t => {
  const config = { model_profile: "openai-codex/swe-2-high:high" }
  const h = fixture(t, config)
  await h.run()
  assert.deepEqual(row(h.render(), `main (${config.model_profile})`), ["codex/swe-2-high:H"])
  assert.deepEqual(h.readConfig(), config)
})

for (const verb of ["set", "add", "remove"]) {
  test(`${verb} uses canonical IDs for editing and compact labels in its result chain`, async t => {
    const config = { categories: { custom: { models: canonical } } }
    const h = fixture(t, config)
    const edited = verb === "remove" ? canonical.slice(1) : canonical
    const displayed = verb === "remove" ? labels.slice(1) : labels
    await h.run(`${verb} custom ${verb === "set" ? canonical.join(" ") : canonical[0]}`)
    assert.deepEqual(h.readConfig().categories.custom.models, edited)
    assert.deepEqual(row(h.render(), "custom"), displayed)
    assert.deepEqual(h.render()[0].split(": ").slice(1).join(": ").split(" → "), displayed)
  })
}

test("editing builtin alternatives expands canonical providers, not their display aliases", async t => {
  const h = fixture(t, {})
  await h.run("add deep claude-sdk-oauth/claude-fable-5-1:max")
  assert.deepEqual(h.readConfig()["[senpi]"].categories.deep.models, [
    "openai-codex/swe-2-high:high", "github-copilot/swe-2-high:high",
    "future-provider/swe-2-high:high", "claude-sdk-oauth/claude-fable-5-1:max",
  ])
  assert.deepEqual(row(h.render(), "deep"), [
    "codex/swe-2-high:H", "gh/swe-2-high:H", "future-provider/swe-2-high:H", "claude/claude-fable-5-1:X",
  ])
})

test("display aliases are not expanded as new input grammar", async t => {
  const h = fixture(t, { categories: { custom: { models: ["openai-codex/swe-2-high:high"] } } })
  await h.run("remove custom codex/swe-2-high:H")
  assert.deepEqual(h.readConfig().categories.custom.models, ["openai-codex/swe-2-high:high"])
})

test("compact widget data survives narrow and wide resizes without clipping", async t => {
  const h = fixture(t, { model_profile: "capable", agents: { explore: { models: ["claude-sdk-oauth/swe-2-high:high"] } } })
  await h.run()
  const original = h.render()
  assert.deepEqual(row(original, "deep"), ["{codex|gh|future-provider}/swe-2-high:H"])
  // Wrapping reflows table cells, so compare the data itself, not its reading order.
  const inventory = lines => [...lines.join("").replace(/\s/gu, "")].sort().join("")
  for (const width of [24, 40, 120]) {
    const rendered = h.render(width)
    assert.ok(rendered.every(line => [...line].length <= width), `overflow at ${width}`)
    assert.equal(inventory(rendered), inventory(original), `lost data at ${width}`)
    if (process.env.ROUTING_RENDER_EVIDENCE === "1") {
      const start = rendered.findIndex(line => line.startsWith("main (capable)"))
      const end = rendered.findIndex((line, index) => index > start && line.startsWith("categories:"))
      console.log(`width=${width}\n${rendered.slice(start, end).join("\n")}`)
    }
  }
})
