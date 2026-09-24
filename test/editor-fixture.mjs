// Shared fixtures for the /routing edit tests: a loaded builtin in the shape
// loadBuiltinRouting returns, a model registry, a two-layer config, key codes
// and an independent terminal-cell oracle. No OMO install is needed.
import assert from "node:assert/strict"
import { RoutingEditor, availabilityOf } from "../extension/routing.ts"

export const BUILTIN = {
  status: "loaded",
  source: "fixture",
  defaults: {
    categories: {
      quick: [
        { providers: ["chatgpt-subscription", "openrouter"], model: "gpt-mini", variant: "low" },
        { providers: ["anthropic-subscription"], model: "claude-haiku", variant: "off" },
      ],
      deep: [
        { providers: ["chatgpt-subscription"], model: "gpt-big", variant: "high" },
        { providers: ["kimi"], model: "k3" },
      ],
      writing: [{ providers: ["anthropic-subscription"], model: "claude-fable", variant: "low" }],
    },
    agents: { explore: [{ providers: ["anthropic-subscription"], model: "claude-haiku" }] },
    model_profiles: { capable: [{ providers: ["anthropic-subscription"], model: "claude-opus", variant: "high" }] },
    agentCategories: { reviewer: ["deep"] },
    categoryModels: {},
    descriptions: { categories: { quick: "Fast small work. Second sentence." }, agents: {}, model_profiles: {} },
    unavailable: {},
  },
}

export const MODELS = [
  { provider: "anthropic-subscription", id: "claude-haiku", name: "Claude Haiku", reasoning: false },
  { provider: "anthropic-subscription", id: "claude-opus", name: "Claude Opus", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "anthropic-subscription", id: "claude-fable", name: "Claude Fable", reasoning: true },
  { provider: "chatgpt-subscription", id: "gpt-mini", name: "GPT Mini", reasoning: true },
  { provider: "chatgpt-subscription", id: "gpt-big", name: "GPT Big", reasoning: true },
  { provider: "devin", id: "swe-2-high", name: "SWE-2 high", reasoning: false },
]
export const REGISTRY = { getAvailable: () => MODELS }

// base [native] pins deep and defines a user-only implementer; profile `work`
// overrides quick (and disables it); `legacy` only has a [senpi] section.
export const RAW = {
  "[native]": {
    categories: {
      deep: { models: ["anthropic-subscription/claude-opus:high"] },
      implementer: { description: "Writes production code.", models: ["anthropic-subscription/claude-opus:high"] },
    },
  },
  profiles: {
    work: { "[native]": { model_profile: "capable", categories: { quick: { models: ["devin/swe-2-high"], disable: true } } } },
    legacy: { "[senpi]": { categories: { writing: { disable: true } } } },
    both: { "[native]": {}, "[senpi]": { categories: { writing: { disable: true } } } },
  },
}

export const KEY = {
  up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t",
  shiftUp: "\x1b[1;2A", shiftDown: "\x1b[1;2B", backspace: "\x7f", del: "\x1b[3~",
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Emoji_Presentation}/u
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
export const strip = text => text.replace(ansi, "")
/** Terminal cells of a rendered line: Hangul and CJK take two, ANSI styling none. */
export const cells = text => [...segmenter.segment(strip(text))].reduce((sum, { segment }) => sum + (wide.test(segment) ? 2 : 1), 0)

/** A rendered line without the overlay frame: the title from the top edge,
 * the content between `│ ` and ` │`, a short rule for `├──┤`/`╰──╯`. */
export function unframe(line) {
  const text = strip(line)
  if (text.startsWith("╭─ ")) return text.slice(3).replace(/ ─*╮$/, "")
  if (/^[├╰]─*[┤╯]$/.test(text)) return "────────"
  if (text.startsWith("│ ") && text.endsWith(" │")) return text.slice(2, -2)
  return text
}

export const press = (editor, ...keys) => { for (const key of keys) editor.handleInput(key) }

/** Move the list cursor down to the row labelled `label`. */
export function select(editor, label, width = 140) {
  editor.handleInput("\x1b[H") // Home: rows above the cursor count too
  for (let i = 0; i < 40; i++) {
    if (editor.render(width).some(line => unframe(line).startsWith(`▸ ${label} `))) return
    editor.handleInput(KEY.down)
  }
  assert.fail(`no list row ${label}`)
}

export const screen = (editor, width = 140) => editor.render(width).map(line => unframe(line).trimEnd()).join("\n")

export function makeEditor(options = {}) {
  const saves = []
  const closed = []
  const editor = new RoutingEditor({
    raw: RAW, builtin: BUILTIN, availability: availabilityOf(REGISTRY), omo: "1.2.3", rows: () => 60,
    save: (drafts, confirm) => {
      saves.push({ drafts: structuredClone(drafts), confirm })
      return options.saveResult?.(drafts, confirm) ?? { status: "saved", text: "{}", count: drafts.length, backup: "x.bak" }
    },
    done: result => closed.push(result),
    ...options,
  }, options.theme)
  return { editor, saves, closed }
}
