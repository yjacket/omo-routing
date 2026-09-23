// routing: print effective model routing from installed OMO defaults and ~/.omo/omo.jsonc — the
// per-category and per-agent chains — for the current profile, or for a
// profile named on the command line.
//
//   /routing            current profile (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR tail; else base)
//   /routing <profile>  `profiles.<name>` applied on top of the base config
//   /routing base       base config only, no profile overlay
//   /routing off        hide the widget (a bare /routing also toggles it off)
//
//   /routing help       usage for every form
//   /routing models [--profile <name>|--base]   enabled categories grouped by the
//                       model they would try at each candidate position (1차, 2차, …)
//   /routing set    <name> <model...>   replace the chain (full fallback order)
//   /routing set    <name> <n> <model...>   replace rung n (1-based) only
//   /routing prepend <name> <model...>  insert rungs at the front
//   /routing add    <name> <model...>   append rungs
//   /routing remove <name> <model...>   drop rungs
//     With `set <n>` and `prepend`, a model that already sits elsewhere in the
//     chain moves to the new position; `add` skips rungs already present.
//     <name>:   main | main:<model_profile> | <category> | <agent> | category:<n> | agent:<n>
//     <model>:  provider/model[:variant]
//     --profile <name> / --base pick the layer written; default is the current
//     profile's `[native]` section (base when no profile is set).
//
// Resolution mirrors omo-task.js: layers merge base -> [native] -> profile base
// -> profile [native], where a layer without `[native]` uses its legacy
// `[senpi]` section instead; objects deep-merge, arrays replace. Edits are applied to
// the omo.jsonc text at byte offsets, so comments and formatting survive; a
// copy of the previous file is kept as omo.jsonc.bak. Nothing is checked
// against live provider state.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, userInfo } from "node:os"

export type Deps = { env?: Record<string, string | undefined>; home?: string }

const SKIP_KEYS = new Set(["__proto__", "constructor", "prototype"])
const HARNESS_KEYS = new Set(["[opencode]", "[native]", "[senpi]", "[codex]", "[omo]"])

/** Strip // and /* *\/ comments without touching string literals. */
export function stripJsonc(src: string): string {
  let out = ""
  let i = 0
  let inStr = false
  while (i < src.length) {
    const c = src[i]
    if (inStr) {
      out += c
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue }
    out += c
    i++
  }
  return out
}

export function parseJsonc(src: string): any {
  return JSON.parse(stripJsonc(src))
}

const isObj = (v: any): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.prototype.toString.call(v) === "[object Object]"

function cloneValue(v: any): any {
  if (Array.isArray(v)) return v.map(cloneValue)
  if (!isObj(v)) return v
  const out: Record<string, any> = {}
  for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) out[k] = cloneValue(x)
  return out
}

/** omo merge: objects merge recursively, arrays and scalars replace. */
export function mergeConfig(base: any, overlay: any): any {
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(overlay ?? {})) {
    if (SKIP_KEYS.has(k)) continue
    const c = cloneValue(v)
    const cur = out[k]
    out[k] = isObj(cur) && isObj(c) ? mergeConfig(cur, c) : c
  }
  return out
}

const nonEmpty = (v: string | undefined): string | undefined => (v === "" ? undefined : v)

/** Same precedence as omo-task.js: OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR ending in profiles/<name>. */
export function resolveProfileName(env: Record<string, string | undefined>): string | undefined {
  const fromDir = (d: string | undefined) => nonEmpty(d?.match(/(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]*$/)?.[1])
  return nonEmpty(env.OMO_PROFILE) ?? nonEmpty(env.OCX_PROFILE) ?? fromDir(env.OPENCODE_CONFIG_DIR)
}

const withoutSpecial = (cfg: any): any => {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(cfg ?? {})) if (k !== "profiles" && !HARNESS_KEYS.has(k)) out[k] = v
  return out
}
/** OMO renames a layer's legacy `[senpi]` to `[native]` on load and drops it
 * when `[native]` is already there, so exactly one of them applies per layer. */
const harnessSection = (cfg: any): any => {
  const section = isObj(cfg) && Object.hasOwn(cfg, "[native]") ? cfg["[native]"] : cfg?.["[senpi]"]
  return isObj(section) ? section : {}
}

export function profileNames(raw: any): string[] {
  return isObj(raw?.profiles) ? Object.keys(raw.profiles) : []
}

/**
 * Effective config for the native harness: base -> [native] -> profile base ->
 * profile [native] (`[senpi]` standing in for a missing `[native]`). `profile`
 * is the name actually applied (undefined for base or when the named profile
 * does not exist, in which case `warning` is set).
 */
export function applyProfile(raw: any, profile: string | undefined): { config: any; profile?: string; warning?: string } {
  const profiles = isObj(raw?.profiles) ? raw.profiles : {}
  const overlay = profile && isObj(profiles[profile]) ? profiles[profile] : undefined
  const warning = profile && !overlay ? `profile "${profile}" does not exist; showing the base configuration` : undefined
  let merged: any = {}
  for (const layer of [withoutSpecial(raw), harnessSection(raw), withoutSpecial(overlay), harnessSection(overlay)])
    merged = mergeConfig(merged, layer)
  return { config: withoutSpecial(merged), profile: overlay ? profile : undefined, warning }
}

type BuiltinRung = { providers: string[]; model: string; variant?: string }
type BuiltinDefaults = {
  categories: Record<string, BuiltinRung[]>
  agents: Record<string, BuiltinRung[]>
  model_profiles: Record<string, BuiltinRung[]>
  agentCategories: Record<string, string[]>
  categoryModels: Record<string, string>
  descriptions: { categories: Record<string, string>; agents: Record<string, string>; model_profiles: Record<string, string> }
}
export type BuiltinRouting =
  | { status: "loaded"; defaults: BuiltinDefaults; source: string }
  | { status: "unavailable"; reason: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string")
const rungs = (value: unknown): value is BuiltinRung[] => Array.isArray(value) && value.length > 0 && value.every(v =>
  record(v) && strings(v.providers) && v.providers.length > 0 && typeof v.model === "string" && (v.variant === undefined || typeof v.variant === "string"))

/** Read only JSON-like literal data, never import/eval the host's executable bundles.
 * OMO's shipped tables use quoted strings and unquoted property names, and share
 * provider lists through array spreads (`providers:[...a8]`). A spread is read
 * from its literal `name=[...]` definition in the same bundle, never evaluated.
 * Any other expression (calls, references, object spreads, etc.) is unsupported.
 */
function sourceLiteral(source: string, start: number, spreadDepth = 2): unknown {
  const token = /\s*("(?:\\.|[^"\\])*"|\.\.\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|[{}[\]:,])/y
  let cursor = start
  const open: string[] = []
  let json = ""
  do {
    token.lastIndex = cursor
    const match = token.exec(source)
    if (!match) return undefined
    const text = match[1]
    cursor = token.lastIndex
    if (text === "{" || text === "[") open.push(text)
    if (text === "}" || text === "]") open.pop()
    if (text.startsWith("...")) {
      const items = open.at(-1) === "[" && spreadDepth > 0 ? spreadArray(source, text.slice(3), spreadDepth - 1) : undefined
      if (!items?.length) return undefined
      json += JSON.stringify(items).slice(1, -1)
    } else if (/^[A-Za-z_$]/.test(text)) {
      if (/^\s*:/.test(source.slice(cursor))) json += JSON.stringify(text)
      else if (["true", "false", "null"].includes(text)) json += text
      else return undefined
    } else json += text
  } while (open.length > 0)
  try { return JSON.parse(json) } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/** Elements behind `...name`: every `name=[...]` literal in the bundle must be
 * the same array. Minifiers reuse short names across scopes, so conflicting or
 * missing definitions are unsupported rather than guessed. */
function spreadArray(source: string, name: string, spreadDepth: number): unknown[] | undefined {
  const definition = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*=(?!=)\\s*(?=\\[)`, "g")
  const values = [...source.matchAll(definition)].map(match => sourceLiteral(source, match.index + match[0].length, spreadDepth))
  if (!values.length || !values.every(Array.isArray)) return undefined
  const first = JSON.stringify(values[0])
  return values.every(value => JSON.stringify(value) === first) ? values[0] as unknown[] : undefined
}

/** Decode one quoted literal from the bundle; OMO ships both '…' and "…" strings. */
function sourceString(raw: string): string | undefined {
  const json = raw.startsWith('"') ? raw : `"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"')}"`
  try {
    const value = JSON.parse(json)
    return typeof value === "string" ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

const SOURCE_STRING = `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`

function builtinTables(source: string, main: boolean): Record<string, unknown>[] {
  // The discriminator is the data shape, not minifier-generated variable names
  // or field order: a main profile is any object whose first entry carries a
  // `models` rung list (OMO added `family`/`tier` ahead of `displayName`).
  const pattern = main
    ? /\{\s*(?:"[^"\\]+"|[\w$]+)\s*:\s*\{[^{}]*?\bmodels\s*:\s*\[\s*\{\s*providers\s*:/g
    : /\{\s*(?:"[^"\\]+"|[\w$]+)\s*:\s*\[\s*\{\s*providers\s*:/g
  return [...source.matchAll(pattern)].flatMap(match => {
    const value = sourceLiteral(source, match.index)
    return record(value) ? [value] : []
  })
}

/** OMO's launcher exports OMO_BIN. Do not guess a different global installation. */
export function loadBuiltinRouting(env: Record<string, string | undefined>): BuiltinRouting {
  if (!env.OMO_BIN) return { status: "unavailable", reason: "OMO_BIN is not set; installed OMO source cannot be located" }
  const extensions = join(dirname(env.OMO_BIN), "..", "plugin", "extensions")
  try {
    const task = readFileSync(join(extensions, "omo-task.js"), "utf8")
    const main = readFileSync(join(extensions, "omo.js"), "utf8")
    // Tables are told apart by shape, never by a particular category name:
    // OMO renames categories (deep -> deep-low/deep-high) and any name check
    // would silently drop every builtin default on the next rename.
    const tables = builtinTables(task, false).filter(t => Object.values(t).every(rungs))
    const definedCategories = [...task.matchAll(/\{name:"([^"\\]+)",config:(\{)/g)].map(match => match[1])
    const agentTables = tables.filter(t => rungs(t.explore) && rungs(t.librarian))
    const categoryTables = tables.filter(t => !agentTables.includes(t)
      && (!definedCategories.length || Object.keys(t).some(name => definedCategories.includes(name))))
    const profileTables = builtinTables(main, true).filter(t => Object.values(t).every(v => record(v) && rungs(v.models)))
    if (categoryTables.length !== 1 || agentTables.length !== 1 || profileTables.length !== 1)
      return { status: "unavailable", reason: `unsupported or ambiguous builtin tables in ${extensions} (categories: ${categoryTables.length}, agents: ${agentTables.length}, model profiles: ${profileTables.length})` }
    const defaults: BuiltinDefaults = {
      categories: {}, agents: {}, model_profiles: {}, agentCategories: {}, categoryModels: {},
      descriptions: { categories: {}, agents: {}, model_profiles: {} },
    }
    for (const [section, table] of [["categories", categoryTables[0]], ["agents", agentTables[0]], ["model_profiles", profileTables[0]]] as const) {
      for (const [name, value] of Object.entries(table)) {
        const chain = section === "model_profiles" && record(value) ? value.models : value
        if (!rungs(chain)) return { status: "unavailable", reason: `unsupported builtin chain ${section}.${name} in ${extensions}` }
        defaults[section][name] = chain
        if (section === "model_profiles" && record(value)) {
          const label = [value.description, value.displayName].find(text => typeof text === "string" && text.trim())
          if (typeof label === "string") defaults.descriptions.model_profiles[name] = label
        }
      }
    }
    // Role descriptions are context, never routing data: an absent or unreadable
    // description leaves the cell empty instead of inventing one.
    for (const [pattern, section] of [
      [new RegExp(`\\{name:"([^"\\\\]+)",config:\\{[^{}]*\\},description:${SOURCE_STRING}`, "g"), "categories"],
      [new RegExp(`\\{name:"([^"\\\\]+)",description:${SOURCE_STRING},mode:"subagent"`, "g"), "agents"],
    ] as const) {
      for (const match of task.matchAll(pattern)) {
        const text = sourceString(match[2])
        if (text) defaults.descriptions[section][match[1]] = text
      }
    }
    // Category definitions have a preferred model before their fallback table.
    for (const match of task.matchAll(/\{name:"([^"\\]+)",config:(\{)/g)) {
      const config = sourceLiteral(task, match.index + match[0].length - 1)
      if (!record(config) || typeof config.model !== "string")
        return { status: "unavailable", reason: `unsupported category default in ${extensions}` }
      defaults.categoryModels[match[1]] = `${config.model}${typeof config.variant === "string" ? `:${config.variant}` : ""}`
    }
    // Some builtin agents route through categories rather than their own table.
    for (const match of task.matchAll(/\{name:"([^"\\]+)",[^{}]*?categories:(\[[^\]]*\])/g)) {
      const categories = sourceLiteral(match[2], 0)
      if (!strings(categories)) return { status: "unavailable", reason: `unsupported agent categories in ${extensions}` }
      defaults.agentCategories[match[1]] = categories
    }
    return { status: "loaded", defaults, source: extensions }
  } catch (error) {
    return { status: "unavailable", reason: `cannot read installed OMO source: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const builtinModels = (chain: BuiltinRung[]): string[] => chain.flatMap(rung =>
  rung.providers.map(provider => `${provider}/${rung.model}${rung.variant ? `:${rung.variant}` : ""}`))
const builtinDisplay = (chain: BuiltinRung[]): string[] => chain.map(rung =>
  `${rung.providers.length === 1 ? rung.providers[0] : `{${rung.providers.join("|")}}`}/${rung.model}${rung.variant ? `:${rung.variant}` : ""}`)

type ChainSource = "configured" | "builtin" | "configured + builtin" | "categories" | "disabled" | "unresolved"
type ChainSections<T> = { categories: Record<string, T>; agents: Record<string, T>; model_profiles: Record<string, T> }

/** Resolve candidate chains before provider availability/auth checks. Category models
 * replace the singular model; agents prepend it. Empty main profiles override
 * builtins, unlike empty category/agent chains, which still fall back.
 */
export function resolveRouting(config: Record<string, unknown>, builtin: BuiltinRouting) {
  const defaults = builtin.status === "loaded" ? builtin.defaults : undefined
  const effective = mergeConfig({}, config)
  const sources: ChainSections<ChainSource> = { categories: {}, agents: {}, model_profiles: {} }
  const display: ChainSections<string[]> = { categories: {}, agents: {}, model_profiles: {} }
  const fallbacks: ChainSections<string[]> = { categories: {}, agents: {}, model_profiles: {} }
  const fallbackModels: ChainSections<string[]> = { categories: {}, agents: {}, model_profiles: {} }
  for (const section of ["categories", "agents", "model_profiles"] as const) {
    const configured = record(config[section]) ? config[section] : {}
    const builtinEntries = defaults?.[section] ?? {}
    effective[section] = {}
    const names = new Set([...Object.keys(builtinEntries), ...Object.keys(configured), ...(section === "agents" ? Object.keys(defaults?.agentCategories ?? {}) : [])])
    for (const name of names) {
      const entry = record(configured[name]) ? configured[name] : {}
      const defaultChain = builtinEntries[name] ?? []
      let chain = section === "categories" && Array.isArray(entry.models) && entry.models.length
        ? chainOf({ models: entry.models })
        : section === "categories"
          ? chainOf({ model: entry?.model, models: typeof entry?.fallback_models === "string" ? [entry.fallback_models] : entry?.fallback_models })
          : section === "model_profiles" ? chainOf({ models: entry?.models }) : chainOf(entry)
      let source: ChainSource = chain.length || (section === "model_profiles" && Object.hasOwn(configured, name)) ? "configured" : "unresolved"
      if (entry?.disable === true) source = "disabled"
      else if (section === "categories" && !(Array.isArray(entry.models) && entry.models.length) && !entry.model && defaultChain.length) {
        const primary = defaults?.categoryModels[name]
        const prefix = [...(primary ? [primary] : []), ...chain]
        source = chain.length ? "configured + builtin" : "builtin"
        chain = [...prefix, ...builtinModels(defaultChain)]
        display.categories[name] = [...prefix, ...builtinDisplay(defaultChain)]
      } else if (source === "unresolved" && section === "agents" && defaults?.agentCategories[name]) {
        const categories = defaults.agentCategories[name]
        chain = categories.flatMap(category => sources.categories[category] === "disabled" ? [] : effective.categories[category]?.models ?? [])
        display.agents[name] = categories.flatMap(category => sources.categories[category] === "disabled" ? [] : display.categories[category] ?? [])
        source = "categories"
      } else if (source === "unresolved" && defaultChain.length) {
        chain = builtinModels(defaultChain)
        display[section][name] = builtinDisplay(defaultChain)
        source = "builtin"
      }
      if (source === "configured" && section === "agents") {
        const categories = defaults?.agentCategories[name] ?? []
        const live = (category: string) => sources.categories[category] !== "disabled"
        fallbacks.agents[name] = [...categories.filter(live).flatMap(category => display.categories[category] ?? []), ...builtinDisplay(defaultChain)]
        fallbackModels.agents[name] = [...categories.filter(live).flatMap(category => effective.categories[category]?.models ?? []), ...builtinModels(defaultChain)]
      }
      sources[section][name] = source
      display[section][name] ??= chain
      // Materialized model lists are for editing only; provider alternatives stay
      // grouped in the report. Never merge these defaults into the raw file.
      effective[section][name] = { ...entry, model: undefined, models: chain }
    }
  }
  const mainSelection = typeof config?.model_profile === "string" ? config.model_profile.trim() || undefined : undefined
  const mainChain = mainSelection?.includes("/") ? [mainSelection] : display.model_profiles[mainSelection ?? ""] ?? []
  return { config: effective, sources, display, fallbacks, fallbackModels, mainSelection, mainChain }
}

/** Chain of an agent/category/model_profile entry as "provider/model:variant" strings. */
export function chainOf(entry: any): string[] {
  if (!isObj(entry)) return []
  const specs = [...(entry.model !== undefined ? [entry.model] : []), ...(Array.isArray(entry.models) ? entry.models : [])]
  return specs
    .map((s) => {
      if (!isObj(s) || typeof s.model !== "string") return s
      const effort = s.reasoning ?? s.variant
      return s.model + (effort ? `:${effort}` : "")
    })
    .filter((s): s is string => typeof s === "string" && s.length > 0)
}

const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map([
  ["openai-codex", "codex"], ["claude-sdk-oauth", "claude"], ["github-copilot", "gh"],
])
// Single letters for the efforts that appear in chains; `minimal` and `auto`
// keep their two-letter labels. `off` and `none` share a letter on screen but
// stay separate canonical values everywhere else.
const EFFORT_LABELS: ReadonlyMap<string, string> = new Map([
  ["max", "X"], ["xhigh", "E"], ["high", "H"], ["medium", "M"],
  ["low", "L"], ["off", "O"], ["none", "O"], ["minimal", "mi"], ["auto", "au"],
])

/** Presentation only: never feed labels back into resolution, parsing or writes. */
const labelProvider = (id: string): string => PROVIDER_LABELS.get(id) ?? id
const labelProviderGroup = (group: string): string =>
  group.startsWith("{") && group.endsWith("}")
    ? `{${group.slice(1, -1).split("|").map(labelProvider).join("|")}}`
    : labelProvider(group)
// Only the final colon suffix is an effort; swe-2-high is a model name.
const labelModel = (id: string): string => id.replace(/:([^:]+)$/, (suffix: string, effort: string) =>
  EFFORT_LABELS.has(effort) ? `:${EFFORT_LABELS.get(effort)}` : suffix)

type Rung = { group: string; providers: string[]; id: string }

/** Split one candidate spec into its provider(s) and its canonical model ID
 * (model plus effort). A builtin `{a|b}/model` group is one rung. */
function splitRung(spec: string): Rung | undefined {
  const slash = spec.indexOf("/")
  if (slash < 0) return undefined
  const group = spec.slice(0, slash)
  const providers = group.startsWith("{") && group.endsWith("}") ? group.slice(1, -1).split("|") : [group]
  return { group, providers, id: spec.slice(slash + 1) }
}

function formatChain(chain: readonly string[]): string {
  return chain.length ? chain.map(spec => {
    const rung = splitRung(spec)
    return rung ? `${labelProviderGroup(rung.group)}/${labelModel(rung.id)}` : spec
  }).join(" → ") : "(no chain configured)"
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Cell width for the report's plain text (not ANSI-styled terminal output).
 * Ambiguous-width characters, including →, use the usual one-cell setting.
 */
function graphemeWidth(text: string): number {
  if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\u20E3/u.test(text)) return 2
  let width = 0
  for (const char of text.replace(/[\p{Mark}\p{Default_Ignorable_Code_Point}]/gu, "")) {
    const cp = char.codePointAt(0) ?? 0
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1b000 && cp <= 0x1b2ff) || (cp >= 0x1f200 && cp <= 0x1f251) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
    width = Math.max(width, wide ? 2 : 1)
  }
  return width
}

const displayWidth = (text: string): number =>
  [...graphemes.segment(text)].reduce((sum, { segment }) => sum + graphemeWidth(segment), 0)

/** A two-cell glyph cannot physically fit a one-cell viewport. Show its code
 * points losslessly instead of clipping it or splitting a grapheme. */
const wrapUnits = (text: string, width: number): { text: string; cells: number }[] =>
  [...graphemes.segment(text)].flatMap(({ segment }) => {
    const cells = graphemeWidth(segment)
    return cells > width
      ? [...[...segment].map(char => `\\u{${char.codePointAt(0)?.toString(16)}}`).join("")].map(text => ({ text, cells: 1 }))
      : [{ text: segment, cells }]
  })

/** Wrap one line, preferring chain arrows, then provider-group `|`, then spaces,
 * then graphemes. Continuations take `indent`; nothing is ever clipped. */
function wrapText(text: string, width: number, indent: string): string[] {
  if (!(width > 0)) return [text]
  const units = wrapUnits(text, width)
  if (units.reduce((sum, unit) => sum + unit.cells, 0) <= width) return [text]
  const out: string[] = []
  let start = 0
  let prefix = ""
  while (start < units.length) {
    let end = start
    let cells = prefix.length
    let space = start
    let arrow = start
    let group = start
    while (end < units.length && cells + units[end].cells <= width) {
      cells += units[end].cells
      if (units[end].text === " ") space = end
      if (units[end].text === "→" && units[end - 1]?.text === " " && units[end + 1]?.text === " ") arrow = end + 1
      if (units[end].text === "|") group = end + 1
      end++
    }
    const cut = end === units.length ? end : arrow > start ? arrow : group > start ? group : space > start ? space : end
    out.push(prefix + units.slice(start, cut).map(unit => unit.text).join("").trimEnd())
    start = cut
    while (units[start]?.text === " ") start++
    prefix = indent
  }
  return out
}

/** Wrap every report line. Table rows arrive already laid out for this width;
 * free-form header, warning and legend lines keep their hanging indent. */
export function fitLines(lines: string[], width: number): string[] {
  if (!(width > 0)) return lines
  return lines.flatMap(line => {
    const m = line.match(/^(\S+(?: \(\S+\))?\s{2,})(.*)$/)
    const column = m ? displayWidth(m[1]) : 2
    return wrapText(line, width, " ".repeat(column <= width / 2 ? column : width >= 4 ? 2 : 0))
  })
}

// ---------------------------------------------------------------------------
// The approved report table: 카테고리명 | 설명 | 라우팅 | 변경여부, and the
// models table: 모델 | 프로바이더 | 담당 카테고리.

const TABLE_HEAD = ["카테고리명", "설명", "라우팅", "변경여부"] as const
const MODELS_HEAD = ["모델", "프로바이더", "담당 카테고리"] as const
const MODELS_MIN = [12, 8, 12] as const
const COLUMN_GAP = 2
const MIN_DESCRIPTION = 12
const MIN_ROUTING = 16
const MAX_NAME = 24
const DESCRIPTION_SHARE = 0.4
const EMPTY_CELL = "-"

type TableCell = string[]
type TableEntry = { label: string } | { cells: TableCell[] }

const padCell = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - displayWidth(text)))

/** Column widths for this viewport, or `[]` when the columns no longer fit and
 * each cell has to be stacked under its row name instead. */
function columnWidths(rows: TableCell[][], width: number): number[] {
  const natural = naturalWidths(rows, TABLE_HEAD.length)
  const gaps = COLUMN_GAP * (TABLE_HEAD.length - 1)
  if (!(width > 0) || natural.reduce((sum, cells) => sum + cells, 0) + gaps <= width) return natural
  const name = Math.min(natural[0], MAX_NAME)
  const available = width - gaps - name - natural[3]
  if (available < MIN_DESCRIPTION + MIN_ROUTING) return []
  // A chain is wrapped at its arrows and stays readable; a description column
  // squeezed to a proportional sliver is not. Give the text its share first.
  let description = Math.min(natural[1], Math.max(MIN_DESCRIPTION, Math.floor(available * DESCRIPTION_SHARE)))
  let routing = available - description
  if (routing > natural[2]) { routing = natural[2]; description = Math.min(natural[1], available - routing) }
  if (routing < MIN_ROUTING) { routing = MIN_ROUTING; description = available - routing }
  return [name, description, routing, natural[3]]
}

const naturalWidths = (rows: TableCell[][], columns: number): number[] =>
  Array.from({ length: columns }, (_, column) => Math.max(0, ...rows.map(row => Math.max(0, ...row[column].map(displayWidth)))))

/** Shrink the widest column one cell at a time until the row fits, never below
 * its minimum; `[]` when not even the minimums fit and cells must be stacked. */
function shrinkWidths(rows: TableCell[][], width: number, mins: readonly number[]): number[] {
  const widths = naturalWidths(rows, mins.length)
  const gaps = COLUMN_GAP * (mins.length - 1)
  const total = () => widths.reduce((sum, cells) => sum + cells, 0) + gaps
  if (!(width > 0)) return widths
  while (total() > width) {
    let widest = -1
    for (let column = 0; column < widths.length; column++)
      if (widths[column] > mins[column] && (widest < 0 || widths[column] > widths[widest])) widest = column
    if (widest < 0) return []
    widths[widest]--
  }
  return widths
}

type TableSpec = { head: readonly string[]; widths(rows: TableCell[][], width: number): number[] }
const REPORT_TABLE: TableSpec = { head: TABLE_HEAD, widths: columnWidths }
const MODELS_TABLE: TableSpec = { head: MODELS_HEAD, widths: (rows, width) => shrinkWidths(rows, width, MODELS_MIN) }

/** Render header, section labels and rows; cells wrap inside their own column. */
function renderTable(entries: TableEntry[], width: number, spec: TableSpec = REPORT_TABLE): string[] {
  const rows = entries.flatMap(entry => ("cells" in entry ? [entry.cells] : []))
  if (!rows.length) return []
  const widths = spec.widths(rows, width)
  const stacked = widths.length === 0
  const indent = stacked && width >= 4 ? "  " : ""
  return entries.flatMap(entry => {
    if ("label" in entry) return entry.label ? wrapText(entry.label, width, indent) : [""]
    if (stacked) {
      const [name, ...rest] = entry.cells
      return [
        ...name.flatMap(line => wrapText(line, width, indent)),
        ...rest.flat().filter(Boolean).flatMap(line =>
          wrapText(line, Math.max(1, width - indent.length), "").map(part => indent + part)),
      ]
    }
    const wrapped = entry.cells.map((cell, column) => cell.flatMap(line => wrapText(line, widths[column], "")))
    const height = Math.max(...wrapped.map(lines => lines.length))
    return Array.from({ length: height }, (_, line) =>
      wrapped.map((lines, column) => padCell(lines[line] ?? "", widths[column])).join(" ".repeat(COLUMN_GAP)).trimEnd())
  })
}

/** 설명 cell: the configured or builtin role text, shortened to its first
 * sentence so the column stays a column. Never a guess about routing. */
export function summarize(value: unknown, limit = 60): string {
  if (typeof value !== "string") return ""
  const clean = value.replace(/\s+/gu, " ").trim()
  if (!clean) return ""
  let text = clean.match(/^.*?[.!?。！？](?=\s|$)/u)?.[0] ?? clean
  if (displayWidth(text) > limit) {
    let cut = ""
    for (const { segment } of graphemes.segment(text)) {
      if (displayWidth(cut + segment) > limit - 1) break
      cut += segment
    }
    const space = cut.lastIndexOf(" ")
    text = (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()
  }
  return text === clean ? text : `${text.replace(/[.,;:]$/u, "")}…`
}

/** pi-tui component factory: bypasses the host's fixed line cap for string-array
 * widgets. A function source is re-laid-out for every viewport width. */
export function widgetFactory(source: string[] | ((width: number) => string[])) {
  return (_tui: unknown, _theme: unknown) => ({
    render: (width: number) => fitLines(typeof source === "function" ? source(width) : source, width),
    invalidate() {},
  })
}

type Resolved = ReturnType<typeof resolveRouting>

/** Effective routing of one entry: the ordered canonical candidates it would
 * actually try, plus whether it is switched off. Display labels never take part. */
function routingKey(resolved: Resolved, section: "categories" | "agents", name: string): string | undefined {
  const source = resolved.sources[section][name]
  if (source === undefined) return undefined
  if (source === "disabled") return "disabled"
  const models: string[] = (resolved.config as any)[section]?.[name]?.models ?? []
  return JSON.stringify([...new Set([...models, ...(resolved.fallbackModels[section][name] ?? [])])])
}

export type ReportInput = {
  config: any
  profile?: string
  profiles: string[]
  warning?: string
  builtin?: BuiltinRouting
  configPath?: string
}

const suppliedBuiltin = (input: ReportInput): BuiltinRouting =>
  input.builtin ?? { status: "unavailable", reason: "installed OMO source was not supplied" }

/** The header every view shares: applied overlay, main selection, sources and warnings. */
function metadataLines(input: ReportInput, builtin: BuiltinRouting, resolved: Resolved): string[] {
  const { profile, profiles, warning, configPath } = input
  const lines = [
    `config profile: ${profile ?? "base (no overlay)"}   available profiles: ${profiles.length ? profiles.join(", ") : "none defined"}`,
    `main model chain (model_profile): ${resolved.mainSelection ?? "not selected; host/session model is unchanged"}`,
    `user config: ${configPath ?? "absent (~/.omo/omo.jsonc or omo.json)"}`,
    builtin.status === "loaded"
      ? `builtin defaults: ${configPath ? "loaded; used where routing falls back" : "in use"} (${builtin.source})`
      : `warning: builtin defaults unavailable; showing configured chains only (${builtin.reason})`,
  ]
  if (warning) lines.push(`warning: ${warning}`)
  return lines
}

export function buildReport(input: ReportInput, width = 0): string[] {
  const { config } = input
  const builtin = suppliedBuiltin(input)
  const resolved = resolveRouting(config, builtin)
  // The same resolution with no user config at all: the routing OMO would use.
  const baseline = builtin.status === "loaded" ? resolveRouting({}, builtin) : undefined
  const builtinDescriptions = builtin.status === "loaded" ? builtin.defaults.descriptions : undefined
  const lines = metadataLines(input, builtin, resolved)

  // 변경여부 answers "does this route differently from OMO's builtin routing?",
  // not "is there a user config?": an override that reproduces the default is 기본.
  const status = (section: "categories" | "agents", name: string): string => {
    if (!baseline) return "확인 불가"
    const base = routingKey(baseline, section, name)
    return base !== undefined && base === routingKey(resolved, section, name) ? "기본" : "변경"
  }
  const describe = (configured: any, builtinText: string | undefined): string =>
    summarize(configured?.description ?? configured?.display_name ?? builtinText) || EMPTY_CELL
  const rowFor = (section: "categories" | "agents", name: string): TableCell[] => {
    const source = resolved.sources[section][name]
    const routing = source === "disabled" ? ["(disabled)"] : [`${formatChain(resolved.display[section][name])} [${source}]`]
    const fallback = resolved.fallbacks[section][name]
    if (source !== "disabled" && fallback?.length) routing.push(`builtin fallback: ${formatChain(fallback)}`)
    return [[name], [describe((resolved.config as any)[section]?.[name], builtinDescriptions?.[section][name])], routing, [status(section, name)]]
  }

  const entries: TableEntry[] = []
  const selection = resolved.mainSelection
  if (selection) {
    const pinned = selection.includes("/")
    const source = pinned ? "configured pin" : resolved.sources.model_profiles[selection] ?? "unresolved"
    const profileEntry = pinned ? undefined : (resolved.config as any).model_profiles?.[selection]
    const base: string[] | undefined = (baseline?.config as any)?.model_profiles?.[selection]?.models
    const mainStatus = !baseline ? "확인 불가"
      : !pinned && base && JSON.stringify(base) === JSON.stringify(profileEntry?.models ?? []) ? "기본" : "변경"
    entries.push({ label: "main:" }, { cells: [
      [`main (${selection})`],
      [describe(profileEntry, builtinDescriptions?.model_profiles[selection])],
      [`${formatChain(resolved.mainChain)} [${source}]`],
      [mainStatus],
    ] })
  }
  for (const section of ["categories", "agents"] as const) {
    const names = Object.keys(resolved.display[section]).sort()
    if (!names.length) continue
    if (entries.length) entries.push({ label: "" })
    entries.push({ label: `${section}:` }, ...names.map(name => ({ cells: rowFor(section, name) })))
  }
  if (entries.length) {
    lines.push("", ...renderTable([{ cells: TABLE_HEAD.map(head => [head]) }, ...entries], width))
    lines.push("", "변경여부: 기본 = same routing as the OMO builtin default, 변경 = differs, 확인 불가 = builtin routing could not be read.")
    if (builtin.status === "loaded") lines.push("{provider|provider} = alternatives within one builtin rung; availability/auth not checked.")
  }
  return lines
}

// ---------------------------------------------------------------------------
// The models view: which model each enabled category would try at 1차, 2차, …

type ModelGroup = { id: string; providers: string[]; categories: string[] }

/**
 * Enabled categories grouped by canonical model ID + effort at every candidate
 * position. One builtin `{a|b}` rung is a single position whose providers are
 * alternatives; successive configured entries stay separate positions. The key
 * is the canonical ID, so `:off` and `:none` never merge and display labels
 * take no part in the grouping.
 */
export function modelPositions(resolved: Resolved): ModelGroup[][] {
  const positions: Map<string, ModelGroup>[] = []
  for (const name of Object.keys(resolved.display.categories).sort()) {
    if (resolved.sources.categories[name] === "disabled") continue
    resolved.display.categories[name].forEach((spec, index) => {
      const rung = splitRung(spec)
      const id = rung?.id ?? spec
      positions[index] ??= new Map()
      const groups = positions[index]
      const group = groups.get(id) ?? { id, providers: [], categories: [] }
      for (const provider of rung?.providers ?? []) if (!group.providers.includes(provider)) group.providers.push(provider)
      if (!group.categories.includes(name)) group.categories.push(name)
      groups.set(id, group)
    })
  }
  return positions.map(groups => [...(groups?.values() ?? [])])
}

/** Same resolution and metadata as the report, read by model instead of by
 * category. Categories only: agents and the main chain are out of scope here. */
export function buildModelsReport(input: ReportInput, width = 0): string[] {
  const builtin = suppliedBuiltin(input)
  const resolved = resolveRouting(input.config, builtin)
  const lines = metadataLines(input, builtin, resolved)
  const entries: TableEntry[] = []
  modelPositions(resolved).forEach((groups, index) => {
    if (entries.length) entries.push({ label: "" })
    entries.push({ label: `${index + 1}차:` }, ...groups.map(group => ({
      cells: [
        [labelModel(group.id)],
        [group.providers.map(labelProvider).join(", ") || EMPTY_CELL],
        [group.categories.join(", ")],
      ],
    })))
  })
  if (!entries.length) {
    lines.push("", "(no enabled categories to group)")
    return lines
  }
  lines.push("", ...renderTable([{ cells: MODELS_HEAD.map(head => [head]) }, ...entries], width, MODELS_TABLE))
  lines.push("",
    "1차/2차/… = 후보 순서의 위치. 한 행의 여러 프로바이더는 같은 위치의 대안이며, 별개의 폴백 단계가 아닙니다.",
    "Enabled categories only (no agents, no main chain); these are pre-availability candidates, auth is not checked.")
  return lines
}

// ---------------------------------------------------------------------------
// JSONC editing: a position-aware parse of the source so a single value can be
// replaced, inserted, or removed in place without touching anything else.

export type JsoncNode = {
  start: number
  end: number
  kind: "object" | "array" | "scalar"
  members?: { key: string; keyStart: number; value: JsoncNode }[]
}

/** Like stripJsonc but keeps offsets: every comment character becomes a space. */
function blankJsonc(src: string): string {
  let out = ""
  let i = 0
  let inStr = false
  while (i < src.length) {
    const c = src[i]
    if (inStr) {
      out += c
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const block = src[i + 1] === "*"
      const stop = block ? src.indexOf("*/", i + 2) : src.indexOf("\n", i)
      const end = stop === -1 ? src.length : block ? stop + 2 : stop
      for (let j = i; j < end; j++) out += src[j] === "\n" ? "\n" : " "
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}

/** Parse JSONC into a tree of source ranges. Throws on malformed input. */
export function parseJsoncTree(src: string): JsoncNode {
  const s = blankJsonc(src)
  let i = 0
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
  const fail = (what: string): never => { throw new Error(`omo.jsonc: ${what} at offset ${i}`) }
  const str = (): string => {
    const start = i
    i++
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1
    if (s[i] !== '"') fail("unterminated string")
    i++
    return JSON.parse(s.slice(start, i))
  }
  const value = (): JsoncNode => {
    ws()
    const start = i
    if (s[i] === "{") {
      i++
      const members: NonNullable<JsoncNode["members"]> = []
      ws()
      while (s[i] !== "}") {
        if (s[i] !== '"') fail("expected string key")
        const keyStart = i
        const key = str()
        ws()
        if (s[i] !== ":") fail("expected ':'")
        i++
        const v = value()
        members.push({ key, keyStart, value: v })
        ws()
        if (s[i] === ",") { i++; ws(); continue }
        if (s[i] !== "}") fail("expected ',' or '}'")
      }
      i++
      return { start, end: i, kind: "object", members }
    }
    if (s[i] === "[") {
      i++
      ws()
      while (s[i] !== "]") {
        value()
        ws()
        if (s[i] === ",") { i++; ws(); continue }
        if (s[i] !== "]") fail("expected ',' or ']'")
      }
      i++
      return { start, end: i, kind: "array" }
    }
    if (s[i] === '"') { str(); return { start, end: i, kind: "scalar" } }
    while (i < s.length && !/[\s,\]}]/.test(s[i])) i++
    if (i === start) fail("unexpected character")
    return { start, end: i, kind: "scalar" }
  }
  const root = value()
  ws()
  if (i !== s.length) fail("trailing content")
  return root
}

function nodeAt(root: JsoncNode, path: string[]): JsoncNode | undefined {
  let cur: JsoncNode | undefined = root
  for (const key of path) cur = cur?.members?.find((m) => m.key === key)?.value
  return cur
}

/** Leading whitespace of the line containing `offset`. */
const lineIndent = (src: string, offset: number): string => {
  const ls = src.lastIndexOf("\n", offset - 1) + 1
  return src.slice(ls, offset).match(/^[ \t]*/)?.[0] ?? ""
}

/** Indentation of an object's members and of the object's own line, plus the unit between them. */
function indentOf(src: string, obj: JsoncNode, root: JsoncNode): { inner: string; outer: string } {
  const outer = lineIndent(src, obj.start)
  const first = obj.members?.[0]
  if (first && src.slice(obj.start, first.keyStart).includes("\n")) return { inner: lineIndent(src, first.keyStart), outer }
  const rootFirst = root.members?.[0]
  const unit = rootFirst ? lineIndent(src, rootFirst.keyStart) || "  " : "  "
  return { inner: outer + unit, outer }
}

function fmtValue(v: any, indent: string, unit: string, multiline: boolean): string {
  if (Array.isArray(v)) {
    if (!v.length) return "[]"
    if (!multiline) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`
    return `[\n${v.map((x) => indent + unit + fmtValue(x, indent + unit, unit, true)).join(",\n")}\n${indent}]`
  }
  if (isObj(v)) {
    const entries = Object.entries(v)
    if (!entries.length) return "{}"
    if (!multiline) return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${fmtValue(x, indent, unit, false)}`).join(", ")} }`
    return `{\n${entries.map(([k, x]) => `${indent + unit}${JSON.stringify(k)}: ${fmtValue(x, indent + unit, unit, true)}`).join(",\n")}\n${indent}}`
  }
  return JSON.stringify(v)
}

/** Set `path` to `value` in the JSONC text, creating missing objects along the way. */
export function setJsoncPath(src: string, path: string[], value: any): string {
  const root = parseJsoncTree(src)
  if (root.kind !== "object") throw new Error("omo.jsonc: top level is not an object")
  let depth = 0
  let obj = root
  while (depth < path.length) {
    const next = obj.members?.find((m) => m.key === path[depth])?.value
    if (!next || (next.kind !== "object" && depth < path.length - 1)) break
    obj = next
    depth++
  }
  const multiline = (n: JsoncNode) => src.slice(n.start, n.end).includes("\n")
  const unitOf = (inner: string, outer: string) => (inner.length > outer.length ? inner.slice(outer.length) : "  ")
  if (depth === path.length) {
    // exact node exists: replace its text, keeping its inline/multiline style
    const { inner, outer } = indentOf(src, root, root)
    return src.slice(0, obj.start) + fmtValue(value, lineIndent(src, obj.start), unitOf(inner, outer), multiline(obj)) + src.slice(obj.end)
  }
  // insert `path[depth..]` as a nested literal into `obj`
  const { inner, outer } = indentOf(src, obj, root)
  const unit = unitOf(inner, outer)
  let nested: any = value
  for (let k = path.length - 1; k > depth; k--) nested = { [path[k]]: nested }
  const ml = obj.members?.length ? multiline(obj) : true
  const member = `${JSON.stringify(path[depth])}: ${fmtValue(nested, inner, unit, ml)}`
  const last = obj.members?.at(-1)
  if (!last) return src.slice(0, obj.start) + (ml ? `{\n${inner}${member}\n${outer}}` : `{ ${member} }`) + src.slice(obj.end)
  const sep = ml ? `,\n${inner}` : ", "
  return src.slice(0, last.value.end) + sep + member + src.slice(last.value.end)
}

/** Remove the member at `path` from the JSONC text (no-op when absent). */
export function removeJsoncPath(src: string, path: string[]): string {
  const root = parseJsoncTree(src)
  const parent = nodeAt(root, path.slice(0, -1))
  const idx = parent?.members?.findIndex((m) => m.key === path.at(-1)) ?? -1
  if (!parent?.members || idx < 0) return src
  const m = parent.members[idx]
  const next = parent.members[idx + 1]
  const prev = parent.members[idx - 1]
  if (next) return src.slice(0, m.keyStart) + src.slice(next.keyStart)
  if (prev) return src.slice(0, prev.value.end) + src.slice(m.value.end)
  return src.slice(0, parent.start + 1) + src.slice(m.value.end)
}

// ---------------------------------------------------------------------------
// /routing set|add|remove

const EDIT_VERBS = new Set(["set", "prepend", "add", "remove"])

/** `/routing help` text; also the pointer given on a malformed edit. */
export const HELP_LINES = [
  "/routing                      current profile's chains (again or `off` hides)",
  "/routing <profile> | base     a named profile's chains | base config only",
  "/routing help                 this text",
  "",
  "/routing models [--profile <p>|-p <p>|--base]   enabled categories grouped by the model",
  "                              they would try at each candidate position (1차, 2차, …); shows only, never writes",
  "",
  "/routing set    <name> <model...>   replace the chain with these rungs, in fallback order",
  "/routing set    <name> <n> <model...>   replace rung n only (1 = first; a model already in the chain moves there)",
  "/routing prepend <name> <model...>  insert rungs at the front (an existing rung moves to the front)",
  "/routing add    <name> <model...>   append rungs",
  "/routing remove <name> <model...>   drop rungs",
  "",
  "  <name>   main | main:<model_profile> | <category> | <agent> | category:<n> | agent:<n>",
  "  <model>  provider/model[:variant], e.g. openai-codex/gpt-5.6-sol:high",
  "  --profile <p> | --base   layer to write (default: current profile, else base)",
  "",
  "변경여부: 기본 = same routing as the OMO builtin default, 변경 = differs (chain, disable or inherited category),",
  "           확인 불가 = the installed builtin routing could not be read.",
  "Display only: codex=openai-codex, claude=claude-sdk-oauth, gh=github-copilot; other providers unchanged.",
  "Effort labels: X=max, E=xhigh, H=high, M=medium, L=low, O=off or none, mi=minimal, au=auto.",
  "Use canonical IDs for edits, not display labels; model names and unknown values stay unchanged.",
  "Edits touch only that `models` array in ~/.omo/omo.jsonc; the previous file is kept as omo.jsonc.bak.",
]

export type EditArgs = { verb: "set" | "prepend" | "add" | "remove"; target: string; models: string[]; profile?: string; base: boolean; at?: number }

/** `/routing models [--profile <name>|-p <name>|--base]`: the layer to read.
 * Anything else is an error, since this view takes no other argument. */
export function parseModelsArgs(words: readonly string[]): { profile?: string; base: boolean } | string {
  let profile: string | undefined
  let base = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === "--base") base = true
    else if (word === "--profile" || word === "-p") {
      profile = words[++i]
      if (!profile) return "/routing models --profile needs a name (see /routing help)"
    } else return `"${word}" is not an option for /routing models; use --profile <name> or --base (see /routing help)`
  }
  return { profile, base }
}

/** Parse `set|prepend|add|remove [--profile <name>|--base] <target> [<n>] <model...>`; returns an error string on bad input.
 * `<n>` (1-based rung position) is accepted for `set` only. */
export function parseEditArgs(args: string): EditArgs | string {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const verb = words.shift() as EditArgs["verb"]
  let profile: string | undefined
  let base = false
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--base") base = true
    else if (words[i] === "--profile" || words[i] === "-p") {
      profile = words[++i]
      if (!profile) return "--profile needs a name"
    } else rest.push(words[i])
  }
  const [target, ...models] = rest
  if (!target) return `usage: /routing ${verb} [--profile <name>|--base] <name> ${verb === "set" ? "[<n>] " : ""}<provider/model[:variant]...> (see /routing help)`
  let at: number | undefined
  if (/^\d+$/.test(models[0] ?? "")) {
    if (verb !== "set") return `a rung position is only accepted by set (/routing set <name> <n> <model...>; see /routing help)`
    at = Number(models.shift())
    if (at < 1) return `rung position must be 1 or more (1 = first rung)`
  }
  if (!models.length) return `no models given for "${target}" (provider/model[:variant], space separated; see /routing help)`
  const bad = models.find((m) => !/^[^\s/:]+\/[^\s/]+$/.test(m))
  if (bad) return `"${bad}" is not provider/model[:variant] (see /routing help)`
  return at === undefined ? { verb, target, models, profile, base } : { verb, target, models, profile, base, at }
}

/**
 * Where a target lives in the effective config: `main` / `main:<mp>` ->
 * model_profiles; `category:x` / `agent:x` explicit; a bare name must be
 * exactly one of a known category or agent.
 */
export function resolveTarget(target: string, config: any): { path: string[]; label: string } | string {
  const categories = isObj(config?.categories) ? Object.keys(config.categories) : []
  const agents = isObj(config?.agents) ? Object.keys(config.agents) : []
  if (target === "main" || target.startsWith("main:")) {
    const mp = target === "main" ? config?.model_profile : target.slice(5)
    if (!mp) return "no model_profile is set; use main:<name>"
    return { path: ["model_profiles", mp], label: `main (${mp})` }
  }
  const m = target.match(/^(category|agent):(.+)$/)
  if (m) return { path: [m[1] === "agent" ? "agents" : "categories", m[2]], label: `${m[1]} ${m[2]}` }
  const isCat = categories.includes(target)
  const isAgent = agents.includes(target)
  if (isCat && isAgent) return `"${target}" is both a category and an agent; use category:${target} or agent:${target}`
  if (isCat) return { path: ["categories", target], label: `category ${target}` }
  if (isAgent) return { path: ["agents", target], label: `agent ${target}` }
  return `unknown target "${target}"; use category:<name> or agent:<name> to create it (known categories: ${categories.join(", ") || "none"}; agents: ${agents.join(", ") || "none"})`
}

/** New chain after applying the verb to the current chain, or an error string.
 * `at` (1-based, `set` only) replaces that one rung. With `set <n>` and
 * `prepend` a model already elsewhere in the chain moves to the new position;
 * `add` keeps existing rungs where they are. A chain never repeats a rung. */
export function applyChainEdit(verb: EditArgs["verb"], current: string[], models: string[], at?: number): string[] | string {
  if (verb === "set" && at !== undefined) {
    if (at > current.length) return `rung ${at} does not exist; the chain has ${current.length} rung${current.length === 1 ? "" : "s"}`
    const out: string[] = []
    current.forEach((m, i) => {
      if (i === at - 1) out.push(...models)
      else if (!models.includes(m)) out.push(m)
    })
    return [...new Set(out)]
  }
  if (verb === "set") return [...new Set(models)]
  if (verb === "prepend") return [...new Set([...models, ...current])]
  if (verb === "add") return [...new Set([...current, ...models])]
  return current.filter((m) => !models.includes(m))
}

export function createRouting(pi: any, deps: Deps = {}) {
  const env = deps.env ?? process.env
  const home = deps.home ?? (userInfo().homedir || homedir())

  let shown = false
  // The host keeps extension widgets across /reload while this closure is
  // recreated, so the old instance clears its widget before reload and the new
  // one clears any leftover on start; otherwise the first /routing after a
  // reload would redraw instead of hiding.
  const hide = (ctx: any) => { if (typeof ctx?.ui?.setWidget === "function") ctx.ui.setWidget("routing", undefined); shown = false }
  if (typeof pi.on === "function") {
    pi.on("session_before_reload", async (_e: unknown, ctx: any) => { hide(ctx) })
    pi.on("session_start", async (_e: unknown, ctx: any) => { hide(ctx) })
  }

  const omoDir = join(home, ".omo")
  const findConfig = () => ["omo.jsonc", "omo.json"].map((f) => join(omoDir, f)).find((p) => existsSync(p))

  const show = (
    ctx: any, raw: any, wanted: string | undefined, extra: string[] = [],
    build: (input: ReportInput, width: number) => string[] = buildReport,
  ) => {
    const profiles = profileNames(raw)
    const { config, profile, warning } = applyProfile(raw, wanted)
    // Read the installed source once; the table itself is laid out per viewport.
    const report = { config, profile, profiles, warning, builtin: loadBuiltinRouting(env), configPath: findConfig() }
    const lines = (width: number) => [...extra, ...build(report, width)]
    // Widget hosts get the table above the editor and nothing else;
    // hosts without a widget get the whole report in the toast.
    if (typeof ctx?.ui?.setWidget === "function") {
      ctx.ui.setWidget("routing", widgetFactory(width => [...lines(width), "", "(/routing again or /routing off to hide)"]), { placement: "aboveEditor" })
      shown = true
    } else {
      ctx.ui.notify(lines(0).join("\n"), "info")
    }
  }

  /** Read-only view of another layer: it never switches the profile and never writes. */
  const models = (words: string[], ctx: any) => {
    const parsed = parseModelsArgs(words)
    if (typeof parsed === "string") { ctx.ui.notify(`routing: ${parsed}`, "error"); return }
    const cfgPath = findConfig()
    const raw = cfgPath ? parseJsonc(readFileSync(cfgPath, "utf8")) : {}
    const profiles = profileNames(raw)
    if (parsed.profile && !profiles.includes(parsed.profile)) {
      ctx.ui.notify(`routing: no profile "${parsed.profile}" in omo.jsonc (available profiles: ${profiles.length ? profiles.join(", ") : "none"})`, "error")
      return
    }
    show(ctx, raw, parsed.base ? undefined : parsed.profile ?? resolveProfileName(env), [], buildModelsReport)
  }

  const edit = (args: string, ctx: any) => {
    const parsed = parseEditArgs(args)
    if (typeof parsed === "string") { ctx.ui.notify(`routing: ${parsed}`, "error"); return }
    const cfgPath = findConfig()
    if (!cfgPath) { ctx.ui.notify(`routing: no omo.jsonc in ${omoDir}`, "error"); return }
    const src = readFileSync(cfgPath, "utf8")
    const raw = parseJsonc(src)
    const profiles = profileNames(raw)

    const profile = parsed.base ? undefined : parsed.profile ?? resolveProfileName(env)
    if (profile && !profiles.includes(profile)) {
      ctx.ui.notify(`routing: no profile "${profile}" in omo.jsonc (available profiles: ${profiles.length ? profiles.join(", ") : "none"}); use --base to edit the base config`, "error")
      return
    }
    const { config: configured } = applyProfile(raw, profile)
    const { config } = resolveRouting(configured, loadBuiltinRouting(env))
    const target = resolveTarget(parsed.target, config)
    if (typeof target === "string") { ctx.ui.notify(`routing: ${target}`, "error"); return }

    // Layer written: the profile's (or base's) harness section OMO applies —
    // `[native]`, else a legacy `[senpi]` — or a new `[native]` when the layer
    // root holds no routing keys; otherwise the layer root.
    const layerPath = profile ? ["profiles", profile] : []
    const layer = profile ? raw.profiles[profile] : raw
    const section = ["[native]", "[senpi]"].find((k) => isObj(layer?.[k]))
      ?? (["categories", "agents", "model_profiles"].some((k) => isObj(layer?.[k])) ? undefined : "[native]")
    const entryPath = [...layerPath, ...(section ? [section] : []), ...target.path]

    const chain = applyChainEdit(parsed.verb, chainOf(config?.[target.path[0]]?.[target.path[1]]), parsed.models, parsed.at)
    if (typeof chain === "string") { ctx.ui.notify(`routing: ${target.label}: ${chain}`, "error"); return }
    let next = removeJsoncPath(src, [...entryPath, "model"])
    next = setJsoncPath(next, [...entryPath, "models"], chain)
    try { parseJsonc(next) } catch (e: any) { ctx.ui.notify(`routing: refusing to write, result is not valid JSON: ${e?.message ?? e}`, "error"); return }
    copyFileSync(cfgPath, cfgPath + ".bak")
    writeFileSync(cfgPath, next, "utf8")
    const where = `${profile ? `profile ${profile}` : "base"}${section ? ` ${section}` : ""}`
    show(ctx, parseJsonc(next), profile, [`wrote ${target.label} in ${where}: ${formatChain(chain)}`, ""])
  }

  pi.registerCommand("routing", {
    description: "show effective model chains (config + installed OMO defaults), or edit config; `help` lists the forms",
    argumentHint: "[profile|base|off|help|models|set|prepend|add|remove ...]",
    handler: async (args: string, ctx: any) => {
      const hasWidget = typeof ctx?.ui?.setWidget === "function"
      const arg = (args ?? "").trim()
      if (hasWidget && (arg === "off" || (arg === "" && shown))) { hide(ctx); return }
      if (arg === "help" || arg === "-h" || arg === "--help") {
        if (hasWidget) { ctx.ui.setWidget("routing", widgetFactory([...HELP_LINES, "", "(/routing again or /routing off to hide)"]), { placement: "aboveEditor" }); shown = true }
        else ctx.ui.notify(HELP_LINES.join("\n"), "info")
        return
      }
      const words = arg.split(/\s+/).filter(Boolean)
      if (words[0] === "models") { models(words.slice(1), ctx); return }
      if (EDIT_VERBS.has(words[0])) { edit(arg, ctx); return }
      const cfgPath = findConfig()
      const raw = cfgPath ? parseJsonc(readFileSync(cfgPath, "utf8")) : {}
      const profiles = profileNames(raw)
      const wanted = arg === "" ? resolveProfileName(env) : arg === "base" ? undefined : arg
      if (arg && arg !== "base" && !profiles.includes(arg)) {
        ctx.ui.notify(`routing: no profile "${arg}" in omo.jsonc (available profiles: ${profiles.length ? profiles.join(", ") : "none"})`, "error")
        return
      }
      show(ctx, raw, wanted)
    },
  })
}

export default function (pi: any): void {
  createRouting(pi)
}
