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
//   /routing edit [--profile <name>|--base]   interactive editor (omo TUI only):
//                       every routing node of the installed OMO with its builtin chain,
//                       the base/profile overrides on top, rungs of providers this
//                       session is not connected to hidden, builtin changes since the
//                       last review flagged; edits are staged and saved together.
//
// Resolution mirrors omo-task.js: layers merge base -> [native] -> profile base
// -> profile [native], where a layer without `[native]` uses its legacy
// `[senpi]` section instead; objects deep-merge, arrays replace. Edits are applied to
// the omo.jsonc text at byte offsets, so comments and formatting survive; a
// copy of the previous file is kept as omo.jsonc.bak. The reports check nothing
// against live provider state; only the editor reads the session's connected
// models (ctx.modelRegistry.getAvailable()) to hide and offer candidates.

import { existsSync, readFileSync, writeFileSync, copyFileSync, lstatSync, mkdirSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { homedir, userInfo } from "node:os"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createContext, runInContext } from "node:vm"

/** `cwd` is where OMO looks for project `.omo/omo.jsonc` files (default: ctx.cwd). */
export type Deps = { env?: Record<string, string | undefined>; home?: string; cwd?: string }

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
type BuiltinSection = "categories" | "agents" | "model_profiles"
type BuiltinDefaults = {
  categories: Record<string, BuiltinRung[]>
  agents: Record<string, BuiltinRung[]>
  model_profiles: Record<string, BuiltinRung[]>
  agentCategories: Record<string, string[]>
  categoryModels: Record<string, string>
  descriptions: { categories: Record<string, string>; agents: Record<string, string>; model_profiles: Record<string, string> }
  /** Sections whose installed table could not be read, with the reason. Their
   * rows show configured chains only; the other sections still load. */
  unavailable: Partial<Record<BuiltinSection, string>>
}
export type BuiltinRouting =
  | { status: "loaded"; defaults: BuiltinDefaults; source: string }
  | { status: "unavailable"; reason: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string")
const rungs = (value: unknown): value is BuiltinRung[] => Array.isArray(value) && value.length > 0 && value.every(v =>
  record(v) && strings(v.providers) && v.providers.length > 0 && typeof v.model === "string" && (v.variant === undefined || typeof v.variant === "string"))
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

// OMO's builtin chains are constants inside its minified bundles, and none of its
// exports or runtime hooks hand them out. The bundles are parsed with the
// @babel/parser that omo-ai itself installs, so JS syntax (`!0`, spreads, quoting,
// field order) is read by a JS parser, not a hand-written tokenizer. Tables are
// recognized by AST shape, never by minifier names or category names, and only
// constant data is evaluated.

type AstNode = { type: string; start: number; end: number; [key: string]: any }
type Bundle = {
  file: string
  source: string
  chainTables: AstNode[]
  profileTables: AstNode[]
  /** Objects with a string `name`: category and agent definitions among others. */
  definitions: AstNode[]
  /** `name=[...]` array literals (declarations or assignments): spread sources. */
  arrays: Map<string, AstNode[]>
  context: Record<string, unknown>
}

/** An installed bundle without the expected shape; its sections are reported
 * unavailable rather than guessed. */
class UnsupportedBundle extends Error {}

const keyOf = (property: AstNode): string | undefined =>
  property.type !== "ObjectProperty" || property.computed ? undefined
    : property.key.type === "Identifier" ? property.key.name
      : property.key.type === "StringLiteral" ? property.key.value : undefined
const propertyOf = (node: AstNode, key: string): AstNode | undefined =>
  node.properties.find((property: AstNode) => keyOf(property) === key)?.value
const keysOf = (node: AstNode): (string | undefined)[] => node.properties.map(keyOf)
const isRung = (node: AstNode | null): boolean => node?.type === "ObjectExpression"
  && propertyOf(node, "providers") !== undefined && propertyOf(node, "model") !== undefined
const isChain = (node: AstNode | undefined): boolean =>
  node?.type === "ArrayExpression" && node.elements.length > 0 && node.elements.every(isRung)
const isTableOf = (node: AstNode, entry: (value: AstNode) => boolean): boolean => node.type === "ObjectExpression"
  && node.properties.length > 0 && node.properties.every((property: AstNode) => keyOf(property) !== undefined && entry(property.value))
const isProfile = (node: AstNode): boolean => node.type === "ObjectExpression" && isChain(propertyOf(node, "models"))
const isAgentTable = (node: AstNode): boolean => ["explore", "librarian"].every(name => keysOf(node).includes(name))

const CONSTANT_UNARY = new Set(["!", "-", "+", "~", "void"])
/** Constant data only: literals, operators over constants, arrays, plain
 * objects, and array spreads of a named array (collected into `spreads`).
 * Calls, functions, member access and every other reference are rejected
 * before anything is evaluated. */
function isConstant(node: AstNode | null, spreads: Set<string>): boolean {
  if (node === null) return true // array hole
  switch (node.type) {
    case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": case "NullLiteral": case "BigIntLiteral":
      return true
    case "TemplateLiteral":
      return node.expressions.every((expression: AstNode) => isConstant(expression, spreads))
    case "UnaryExpression":
      return CONSTANT_UNARY.has(node.operator) && isConstant(node.argument, spreads)
    case "BinaryExpression":
      return node.operator !== "in" && node.operator !== "instanceof" && isConstant(node.left, spreads) && isConstant(node.right, spreads)
    case "LogicalExpression":
      return isConstant(node.left, spreads) && isConstant(node.right, spreads)
    case "ConditionalExpression":
      return [node.test, node.consequent, node.alternate].every(part => isConstant(part, spreads))
    case "ArrayExpression":
      return node.elements.every((element: AstNode | null) => {
        if (element?.type !== "SpreadElement") return isConstant(element, spreads)
        if (element.argument.type !== "Identifier") return false
        spreads.add(element.argument.name)
        return true
      })
    case "ObjectExpression":
      return node.properties.every((property: AstNode) => keyOf(property) !== undefined && isConstant(property.value, spreads))
    default:
      return false
  }
}

/** The value of a constant-data node. A spread `...name` reads the array literal
 * bound to `name` in the same bundle; minifiers reuse short names across scopes,
 * so every such literal must be the same array, and none or several different
 * ones are unsupported rather than guessed. */
function evaluate(bundle: Bundle, node: AstNode, spreadDepth = 2): unknown {
  const spreads = new Set<string>()
  if (!isConstant(node, spreads))
    throw new UnsupportedBundle(`${bundle.file}: non-constant expression in builtin data at offset ${node.start}`)
  for (const name of spreads) {
    const definitions = bundle.arrays.get(name) ?? []
    if (!definitions.length) throw new UnsupportedBundle(`${bundle.file}: no array literal defines ...${name}`)
    if (spreadDepth === 0) throw new UnsupportedBundle(`${bundle.file}: ...${name} is nested too deeply`)
    const values = new Set(definitions.map(definition => JSON.stringify(evaluate(bundle, definition, spreadDepth - 1))))
    if (values.size !== 1) throw new UnsupportedBundle(`${bundle.file}: conflicting array literals define ...${name}`)
    bundle.context[name] = JSON.parse([...values][0])
  }
  // Constant data cannot run code; the VM only supplies JS semantics, and the
  // result is copied out of its realm.
  let value: unknown
  try {
    value = runInContext(`(${bundle.source.slice(node.start, node.end)})`, bundle.context, { timeout: 100 })
  } catch (error) {
    throw new UnsupportedBundle(`${bundle.file}: cannot evaluate builtin data at offset ${node.start}: ${errorText(error)}`)
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** A constant string property, or undefined when absent or not constant data. */
function textOf(bundle: Bundle, node: AstNode, key: string): string | undefined {
  const value = propertyOf(node, key)
  if (value === undefined || !isConstant(value, new Set())) return undefined
  const text = evaluate(bundle, value)
  return typeof text === "string" ? text : undefined
}

function parseBundle(file: string, source: string, parse: (source: string) => AstNode): Bundle | UnsupportedBundle {
  let program: AstNode
  try {
    program = parse(source)
  } catch (error) {
    return new UnsupportedBundle(`cannot parse ${file}: ${errorText(error)}`)
  }
  const bundle: Bundle = {
    file, source, chainTables: [], profileTables: [], definitions: [], arrays: new Map(),
    context: createContext(Object.create(null)),
  }
  const stack = [program]
  while (stack.length) {
    const node = stack.pop() as AstNode
    const [target, value] = node.type === "VariableDeclarator" ? [node.id, node.init]
      : node.type === "AssignmentExpression" && node.operator === "=" ? [node.left, node.right] : []
    if (target?.type === "Identifier" && value?.type === "ArrayExpression")
      bundle.arrays.set(target.name, [...(bundle.arrays.get(target.name) ?? []), value])
    if (node.type === "ObjectExpression") {
      if (isTableOf(node, isChain)) bundle.chainTables.push(node)
      else if (isTableOf(node, isProfile)) bundle.profileTables.push(node)
      else if (propertyOf(node, "name")?.type === "StringLiteral") bundle.definitions.push(node)
    }
    for (const child of Object.values(node))
      for (const item of Array.isArray(child) ? child : [child])
        if (item !== null && typeof item === "object" && typeof item.type === "string") stack.push(item)
  }
  return bundle
}

/** The one table of a kind; none or several are unsupported, never chosen by file order. */
function onlyTable(bundle: Bundle, tables: AstNode[], kind: string): Record<string, unknown> {
  if (tables.length !== 1) throw new UnsupportedBundle(`${bundle.file}: expected one builtin ${kind} table, found ${tables.length}`)
  return evaluate(bundle, tables[0]) as Record<string, unknown>
}

function chainTable(bundle: Bundle, tables: AstNode[], kind: string): Record<string, BuiltinRung[]> {
  const table = onlyTable(bundle, tables, kind)
  for (const [name, chain] of Object.entries(table))
    if (!rungs(chain)) throw new UnsupportedBundle(`${bundle.file}: unsupported builtin ${kind} chain ${name}`)
  return table as Record<string, BuiltinRung[]>
}

function readCategories(bundle: Bundle, defaults: BuiltinDefaults): void {
  // Category definitions carry the preferred model that precedes the fallback table.
  const definitions = bundle.definitions.filter(node => {
    const config = propertyOf(node, "config")
    return config?.type === "ObjectExpression" && propertyOf(config, "model") !== undefined
  })
  const names = definitions.map(node => (propertyOf(node, "name") as AstNode).value as string)
  // Tables are told apart by shape, never by a particular category name: OMO
  // renames categories (deep -> deep-low/deep-high).
  const categories = chainTable(bundle, bundle.chainTables.filter(node => !isAgentTable(node)
    && (!names.length || keysOf(node).some(name => name !== undefined && names.includes(name)))), "category")
  const categoryModels: Record<string, string> = {}
  const descriptions: Record<string, string> = {}
  for (const node of definitions) {
    const name = (propertyOf(node, "name") as AstNode).value as string
    const config = propertyOf(node, "config") as AstNode
    const model = textOf(bundle, config, "model")
    if (model === undefined) throw new UnsupportedBundle(`${bundle.file}: unsupported default model for category ${name}`)
    const variant = textOf(bundle, config, "variant")
    categoryModels[name] = variant === undefined ? model : `${model}:${variant}`
    // Role descriptions are context, never routing data: an absent or unreadable
    // description leaves the cell empty instead of inventing one.
    const description = textOf(bundle, node, "description")
    if (description) descriptions[name] = description
  }
  defaults.categories = categories
  defaults.categoryModels = categoryModels
  defaults.descriptions.categories = descriptions
}

function readAgents(bundle: Bundle, defaults: BuiltinDefaults): void {
  const agents = chainTable(bundle, bundle.chainTables.filter(isAgentTable), "agent")
  const agentCategories: Record<string, string[]> = {}
  const descriptions: Record<string, string> = {}
  for (const node of bundle.definitions) {
    const name = (propertyOf(node, "name") as AstNode).value as string
    if (propertyOf(node, "mode")?.value === "subagent") {
      const description = textOf(bundle, node, "description")
      if (description) descriptions[name] = description
    }
    // Some builtin agents route through categories rather than their own table.
    const categories = propertyOf(node, "categories")
    if (categories?.type !== "ArrayExpression") continue
    const value = evaluate(bundle, categories)
    if (!strings(value)) throw new UnsupportedBundle(`${bundle.file}: unsupported categories for agent ${name}`)
    agentCategories[name] = value
  }
  defaults.agents = agents
  defaults.agentCategories = agentCategories
  defaults.descriptions.agents = descriptions
}

function readProfiles(bundle: Bundle, defaults: BuiltinDefaults): void {
  const profiles: Record<string, BuiltinRung[]> = {}
  const descriptions: Record<string, string> = {}
  for (const [name, entry] of Object.entries(onlyTable(bundle, bundle.profileTables, "main model profile"))) {
    if (!record(entry) || !rungs(entry.models)) throw new UnsupportedBundle(`${bundle.file}: unsupported builtin main model profile ${name}`)
    profiles[name] = entry.models
    const label = [entry.description, entry.displayName].find(text => typeof text === "string" && text.trim())
    if (typeof label === "string") descriptions[name] = label
  }
  defaults.model_profiles = profiles
  defaults.descriptions.model_profiles = descriptions
}

/** The @babel/parser omo-ai installs (a declared dependency), resolved from the
 * install root so the reader follows whatever syntax that OMO build emits. */
function omoParser(root: string): (source: string) => AstNode {
  const { parse } = createRequire(join(root, "package.json"))("@babel/parser")
  return source => parse(source, { sourceType: "module" }).program
}

// Parsing the bundles takes a few hundred milliseconds, so the result is kept
// until their contents change.
let cached: { key: string; routing: BuiltinRouting } | undefined

/** OMO's launcher exports OMO_BIN. Do not guess a different global installation. */
export function loadBuiltinRouting(env: Record<string, string | undefined>): BuiltinRouting {
  if (!env.OMO_BIN) return { status: "unavailable", reason: "OMO_BIN is not set; installed OMO source cannot be located" }
  const root = join(dirname(env.OMO_BIN), "..")
  const extensions = join(root, "plugin", "extensions")
  const sources = new Map(["omo-task.js", "omo.js"].map(name => {
    const file = join(extensions, name)
    try {
      return [name, readFileSync(file, "utf8")] as const
    } catch (error) {
      return [name, new UnsupportedBundle(`cannot read ${file}: ${errorText(error)}`)] as const
    }
  }))
  const hash = createHash("sha256").update(root)
  for (const source of sources.values()) hash.update("\0").update(typeof source === "string" ? source : source.message)
  const key = hash.digest("hex")
  if (cached?.key === key) return cached.routing

  let parse: (source: string) => AstNode
  try {
    parse = omoParser(root)
  } catch (error) {
    return { status: "unavailable", reason: `cannot load the @babel/parser installed with OMO in ${root}: ${errorText(error)}` }
  }
  const bundles = new Map([...sources].map(([name, source]) =>
    [name, typeof source === "string" ? parseBundle(join(extensions, name), source, parse) : source] as const))
  const bundle = (name: string): Bundle => {
    const value = bundles.get(name)
    if (value instanceof UnsupportedBundle) throw value
    return value as Bundle
  }
  const defaults: BuiltinDefaults = {
    categories: {}, agents: {}, model_profiles: {}, agentCategories: {}, categoryModels: {},
    descriptions: { categories: {}, agents: {}, model_profiles: {} }, unavailable: {},
  }
  // Each section stands alone: one unreadable table must not hide the others.
  for (const [section, read] of [
    ["categories", () => readCategories(bundle("omo-task.js"), defaults)],
    ["agents", () => readAgents(bundle("omo-task.js"), defaults)],
    ["model_profiles", () => readProfiles(bundle("omo.js"), defaults)],
  ] as const) {
    try {
      read()
    } catch (error) {
      if (!(error instanceof UnsupportedBundle)) throw error
      defaults.unavailable[section] = error.message
    }
  }
  const failures = Object.values(defaults.unavailable)
  const routing: BuiltinRouting = failures.length === 3
    ? { status: "unavailable", reason: [...new Set(failures)].join("; ") }
    : { status: "loaded", defaults, source: extensions }
  cached = { key, routing }
  return routing
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

// OMO renamed the subscription providers in 2026-09 (openai-codex ->
// chatgpt-subscription, claude-sdk-oauth -> anthropic-subscription); both
// generations keep the approved short labels.
const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map([
  ["openai-codex", "codex"], ["chatgpt-subscription", "codex"],
  ["claude-sdk-oauth", "claude"], ["anthropic-subscription", "claude"],
  ["github-copilot", "gh"],
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
  /** Extra warnings, e.g. project configs that also set routing. */
  notices?: string[]
  /** Builtin changes since the last review in `/routing edit`; shown when nonempty. */
  drift?: Drift
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
  if (builtin.status === "loaded")
    for (const [section, reason] of Object.entries(builtin.defaults.unavailable))
      lines.push(`warning: builtin ${SECTION_LABELS[section as BuiltinSection]} unavailable; those rows show configured chains only (${reason})`)
  if (warning) lines.push(`warning: ${warning}`)
  for (const notice of input.notices ?? []) lines.push(`warning: ${notice}`)
  if (input.drift?.count) lines.push(driftLine(input.drift))
  return lines
}

const SECTION_LABELS: Record<BuiltinSection, string> = {
  categories: "category chains", agents: "agent chains", model_profiles: "main model profiles",
}

export function buildReport(input: ReportInput, width = 0): string[] {
  const { config } = input
  const builtin = suppliedBuiltin(input)
  const resolved = resolveRouting(config, builtin)
  // The same resolution with no user config at all: the routing OMO would use.
  const baseline = builtin.status === "loaded" ? resolveRouting({}, builtin) : undefined
  const builtinDescriptions = builtin.status === "loaded" ? builtin.defaults.descriptions : undefined
  const lines = metadataLines(input, builtin, resolved)

  // A section whose builtin table could not be read cannot be compared. Agents
  // also inherit category routing, so they depend on the category table too.
  const unreadable = (section: BuiltinSection): boolean => builtin.status !== "loaded"
    || section in builtin.defaults.unavailable || (section === "agents" && "categories" in builtin.defaults.unavailable)
  // 변경여부 answers "does this route differently from OMO's builtin routing?",
  // not "is there a user config?": an override that reproduces the default is 기본.
  const status = (section: "categories" | "agents", name: string): string => {
    if (!baseline || unreadable(section)) return "확인 불가"
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
    const mainStatus = !baseline || (!pinned && unreadable("model_profiles")) ? "확인 불가"
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

/** Remove the member at `path` from the JSONC text (no-op when absent). Only
 * the member and one separating comma go: comments above, beside or below it,
 * including those of its neighbours, stay; a line the removal leaves blank is dropped. */
export function removeJsoncPath(src: string, path: string[]): string {
  const root = parseJsoncTree(src)
  const parent = nodeAt(root, path.slice(0, -1))
  const idx = parent?.members?.findIndex((m) => m.key === path.at(-1)) ?? -1
  if (!parent?.members || idx < 0) return src
  const blank = blankJsonc(src)
  const commaAfter = (offset: number): number => {
    let i = offset
    while (i < blank.length && /\s/.test(blank[i])) i++
    return blank[i] === "," ? i : -1
  }
  const m = parent.members[idx]
  const next = parent.members[idx + 1]
  const prev = parent.members[idx - 1]
  let start = m.keyStart
  let end = m.value.end
  // A middle member takes its own comma; the last one takes the previous comma.
  const comma = next ? -1 : prev ? commaAfter(prev.value.end) : -1
  if (next) {
    const own = commaAfter(end)
    if (own >= 0) end = own + 1
    while (src[end] === " " || src[end] === "\t") end++
  }
  const lineStart = src.lastIndexOf("\n", start - 1) + 1
  const newline = src.indexOf("\n", end)
  const lineEnd = newline === -1 ? src.length : newline
  if (/^[ \t]*$/.test(src.slice(lineStart, start)) && /^[ \t\r]*$/.test(src.slice(end, lineEnd))) {
    start = lineStart
    end = newline === -1 ? src.length : newline + 1
  }
  const out = src.slice(0, start) + src.slice(end)
  return comma >= 0 ? out.slice(0, comma) + out.slice(comma + 1) : out
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
  "/routing edit [--profile <p>|-p <p>|--base]   interactive editor in the omo TUI: builtin chains of the",
  "                              installed OMO under your base/profile changes; unconnected providers hidden;",
  "                              builtin changes since the last review flagged; keys are listed in its footer",
  "",
  "변경여부: 기본 = same routing as the OMO builtin default, 변경 = differs (chain, disable or inherited category),",
  "           확인 불가 = the installed builtin routing could not be read.",
  "Display only: codex=chatgpt-subscription|openai-codex, claude=anthropic-subscription|claude-sdk-oauth,",
  "              gh=github-copilot; other providers unchanged.",
  "Effort labels: X=max, E=xhigh, H=high, M=medium, L=low, O=off or none, mi=minimal, au=auto.",
  "Use canonical IDs for edits, not display labels; model names and unknown values stay unchanged.",
  "Edits touch only that `models` array in ~/.omo/omo.jsonc; the previous file is kept as omo.jsonc.bak.",
]

export type EditArgs = { verb: "set" | "prepend" | "add" | "remove"; target: string; models: string[]; profile?: string; base: boolean; at?: number }

/** `/routing models [--profile <name>|-p <name>|--base]`: the layer to read.
 * Anything else is an error, since this view takes no other argument. */
export function parseModelsArgs(words: readonly string[], form = "models"): { profile?: string; base: boolean } | string {
  let profile: string | undefined
  let base = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === "--base") base = true
    else if (word === "--profile" || word === "-p") {
      profile = words[++i]
      if (!profile) return `/routing ${form} --profile needs a name (see /routing help)`
    } else return `"${word}" is not an option for /routing ${form}; use --profile <name> or --base (see /routing help)`
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

// ---------------------------------------------------------------------------
// /routing edit: the interactive editor. The component and everything it uses
// are exported and free of host imports, so the fake harness drives them.

export type Section = "categories" | "agents" | "model_profiles"
const SECTIONS: readonly Section[] = ["categories", "agents", "model_profiles"]
/** The effort suffixes OMO understands on `provider/model:effort`. */
const EFFORTS = new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"])

export type Spec = { providers: string[]; model: string; effort?: string }

/** Split `provider/model[:effort]` or a builtin `{a|b}/model[:effort]` group.
 * The final `:x` is an effort only when x is a known effort, so model names
 * such as `swe-2-high` keep their text. */
export function splitSpec(spec: string): Spec | undefined {
  const slash = spec.indexOf("/")
  if (slash <= 0) return undefined
  const group = spec.slice(0, slash)
  const providers = group.startsWith("{") && group.endsWith("}") ? group.slice(1, -1).split("|") : [group]
  const rest = spec.slice(slash + 1)
  const colon = rest.lastIndexOf(":")
  return colon > 0 && EFFORTS.has(rest.slice(colon + 1))
    ? { providers, model: rest.slice(0, colon), effort: rest.slice(colon + 1) }
    : { providers, model: rest }
}

export const joinSpec = (provider: string, model: string, effort?: string): string =>
  `${provider}/${model}${effort ? `:${effort}` : ""}`

const labelSpec = (spec: string): string => formatChain([spec])

export type ModelInfo = { provider: string; id: string; name: string; reasoning: boolean; source: unknown }
/** The models this session can run. `known: false` means the registry could not
 * be read: nothing is hidden and nothing can be picked. */
export type Availability = { known: boolean; providers: string[]; models: Map<string, ModelInfo>; reason?: string }

/** Connected models from `ctx.modelRegistry.getAvailable()`, the list OMO
 * filters builtin rungs with. Providers keep the registry's order. */
export function availabilityOf(registry: any): Availability {
  const unknown = (reason: string): Availability => ({ known: false, providers: [], models: new Map(), reason })
  if (typeof registry?.getAvailable !== "function") return unknown("no model registry in this context")
  let list: unknown
  try {
    list = registry.getAvailable()
  } catch (error) {
    return unknown(`the model registry failed: ${errorText(error)}`)
  }
  if (!Array.isArray(list)) return unknown("the model registry returned no model list")
  const providers: string[] = []
  const models = new Map<string, ModelInfo>()
  for (const model of list) {
    if (!record(model) || typeof model.provider !== "string" || typeof model.id !== "string") continue
    if (!providers.includes(model.provider)) providers.push(model.provider)
    models.set(`${model.provider}/${model.id}`, {
      provider: model.provider, id: model.id,
      name: typeof model.name === "string" && model.name ? model.name : model.id,
      reasoning: model.reasoning === true, source: model,
    })
  }
  return { known: true, providers, models }
}

export type RungView = { visible: boolean; connected: string[]; hidden: string[]; unknown: boolean }

/** One candidate in this session: which of its providers are connected, and
 * whether a connected provider lacks that model id. */
export function rungView(spec: string, availability: Availability): RungView {
  const parts = splitSpec(spec)
  if (!parts || !availability.known) return { visible: true, connected: parts?.providers ?? [], hidden: [], unknown: false }
  const connected = parts.providers.filter(provider => availability.providers.includes(provider))
  return {
    visible: connected.length > 0,
    connected,
    hidden: parts.providers.filter(provider => !connected.includes(provider)),
    unknown: connected.length > 0 && !connected.some(provider => availability.models.has(`${provider}/${parts.model}`)),
  }
}

/** A provider group narrowed to its connected providers, for display. */
function connectedSpec(spec: string, view: RungView): string {
  if (!view.hidden.length || !view.connected.length) return spec
  const rest = spec.slice(spec.indexOf("/") + 1)
  return `${view.connected.length === 1 ? view.connected[0] : `{${view.connected.join("|")}}`}/${rest}`
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]
export type ThinkingLevelsOf = (model: unknown) => readonly string[] | undefined

/** Efforts to offer for a model: the host's own `getSupportedThinkingLevels`
 * when it could be loaded, else a conservative reading of the model metadata
 * (xhigh/max only when the model's level map names them). An unknown model is
 * offered every effort OMO accepts. */
export function effortLevels(model: ModelInfo | undefined, host?: ThinkingLevelsOf): string[] {
  if (!model) return ["off", ...THINKING_LEVELS]
  try {
    const levels = host?.(model.source)
    if (Array.isArray(levels) && levels.length && levels.every(level => typeof level === "string")) return [...levels]
  } catch {
    // the metadata reading below still applies
  }
  if (!model.reasoning) return ["off"]
  const map = (model.source as any)?.thinkingLevelMap
  return THINKING_LEVELS.filter(level => !record(map)
    ? level !== "xhigh" && level !== "max"
    : map[level] !== null && (level !== "xhigh" && level !== "max" || map[level] !== undefined))
}

/** `getSupportedThinkingLevels` from the pi-ai copy the installed OMO runs,
 * imported from its file (package exports are not assumed). */
export async function hostThinkingLevels(env: Record<string, string | undefined>): Promise<ThinkingLevelsOf | undefined> {
  if (!env.OMO_BIN) return undefined
  const modules = join(dirname(env.OMO_BIN), "..", "node_modules")
  const file = [join(modules, "@code-yeongyu", "senpi", "node_modules"), modules]
    .map(dir => join(dir, "@earendil-works", "pi-ai", "dist", "models.js")).find(path => existsSync(path))
  if (!file) return undefined
  try {
    const loaded = await import(pathToFileURL(file).href)
    return typeof loaded.getSupportedThinkingLevels === "function" ? loaded.getSupportedThinkingLevels : undefined
  } catch {
    return undefined
  }
}

/** One config layer: base (`profile` undefined) or one profile. */
export type LayerRef = { profile?: string }

const layerObject = (raw: any, layer: LayerRef): any => layer.profile === undefined ? raw : pathValue(raw, ["profiles", layer.profile])
/** The harness section OMO applies for a layer, as applyProfile reads it. */
function harnessKey(layer: any): string | undefined {
  if (!isObj(layer)) return undefined
  if (Object.hasOwn(layer, "[native]")) return isObj(layer["[native]"]) ? "[native]" : undefined
  return isObj(layer["[senpi]"]) ? "[senpi]" : undefined
}
const pathValue = (value: any, path: readonly string[]): any =>
  path.reduce((current, key) => (isObj(current) && Object.hasOwn(current, key) ? current[key] : undefined), value)
const samePath = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((key, i) => key === b[i])

/** Where a node lives in one layer: the locations defining it now (layer root,
 * harness section) and the one a write targets, chosen like `/routing set`:
 * the harness section, else the root when it already holds routing keys, else
 * a new `[native]`. */
function entryLocations(raw: any, layer: LayerRef, section: Section, name: string) {
  const prefix = layer.profile === undefined ? [] : ["profiles", layer.profile]
  const object = layerObject(raw, layer)
  const key = harnessKey(object)
  const root = [...prefix, section, name]
  const harness = key ? [...prefix, key, section, name] : undefined
  // A `[native]` that is present but not an object still hides `[senpi]` (OMO
  // applies it as empty); a write replaces it with an object, never adds a twin key.
  const blocked = key === undefined && isObj(object) && Object.hasOwn(object, "[native]")
  const target = harness ?? (!blocked && ["categories", "agents", "model_profiles"].some(k => isObj(object?.[k]))
    ? root : [...prefix, "[native]", section, name])
  return {
    target,
    existing: [root, ...(harness ? [harness] : [])].filter(path => isObj(pathValue(raw, path))),
    reset: blocked ? [...prefix, "[native]"] : undefined,
  }
}

/** One layer's own entry for a node: its root definition merged with its harness section's. */
export function layerEntry(raw: any, layer: LayerRef, section: Section, name: string): Record<string, any> | undefined {
  const { existing } = entryLocations(raw, layer, section, name)
  return existing.length ? existing.reduce((merged, path) => mergeConfig(merged, pathValue(raw, path)), {}) : undefined
}

/** What one layer sets for a node: its own chain (by OMO's rules for that
 * section) and its `disable` flag; undefined when the layer does not name it. */
export type Override = { chain?: string[]; disable?: boolean }
export function overrideOf(section: Section, entry: Record<string, any> | undefined): Override | undefined {
  if (!entry) return undefined
  const chain = section === "categories"
    ? Array.isArray(entry.models) && entry.models.length ? chainOf({ models: entry.models })
      : chainOf({ model: entry.model, models: typeof entry.fallback_models === "string" ? [entry.fallback_models] : entry.fallback_models })
    : section === "model_profiles" ? chainOf({ models: entry.models }) : chainOf(entry)
  return {
    ...(chain.length || (section === "model_profiles" && Array.isArray(entry.models)) ? { chain } : {}),
    ...(typeof entry.disable === "boolean" ? { disable: entry.disable } : {}),
  }
}

/** A staged change to one node in one layer. `chain`: the new candidates;
 * `null` drops this layer's chain so the node follows base or OMO's builtin;
 * absent leaves it. `disable`: true/false, or `null` to drop the key. */
export type EditorDraft = { profile?: string; section: Section; name: string; chain?: string[] | null; disable: boolean | null }

type EditOp = { remove: string[] } | { set: string[]; value: unknown }

/** The edits one draft makes. The layer ends up with exactly the drafted
 * routing: `model` and `fallback_models` go wherever the layer defines the node
 * (they would precede or extend `models`); `models` stays only at the target. */
function draftOps(raw: any, draft: EditorDraft): { ops: EditOp[]; prune: string[][] } {
  const { target, existing, reset } = entryLocations(raw, { profile: draft.profile }, draft.section, draft.name)
  const ops: EditOp[] = []
  if (reset && ((Array.isArray(draft.chain) && draft.chain.length) || draft.disable !== null)) ops.push({ set: reset, value: {} })
  const chain = Array.isArray(draft.chain) ? [...new Set(draft.chain)] : draft.chain
  if (chain !== undefined) {
    for (const path of existing) {
      ops.push({ remove: [...path, "model"] }, { remove: [...path, "fallback_models"] })
      if (!(chain?.length && samePath(path, target))) ops.push({ remove: [...path, "models"] })
    }
    if (chain?.length) ops.push({ set: [...target, "models"], value: chain })
  }
  for (const path of existing) if (draft.disable === null || !samePath(path, target)) ops.push({ remove: [...path, "disable"] })
  if (draft.disable !== null) ops.push({ set: [...target, "disable"], value: draft.disable })
  return { ops, prune: [...existing, target] }
}

const emptyObject = (value: unknown): boolean => isObj(value) && Object.keys(value as object).length === 0

/** Apply drafts to omo.jsonc text in place: comments, key order and the style
 * of untouched values survive, and an entry left empty is removed. */
export function applyDrafts(src: string, drafts: readonly EditorDraft[]): string {
  let text = src
  for (const draft of drafts) {
    const { ops, prune } = draftOps(parseJsonc(text), draft)
    for (const op of ops) text = "remove" in op ? removeJsoncPath(text, op.remove) : setJsoncPath(text, op.set, op.value)
    for (const path of prune) if (emptyObject(pathValue(parseJsonc(text), path))) text = removeJsoncPath(text, path)
  }
  return text
}

/** The same edits on a parsed config: what the editor shows before saving. */
export function applyDraftsToConfig(raw: any, drafts: readonly EditorDraft[]): any {
  const out = cloneValue(isObj(raw) ? raw : {})
  const parentOf = (path: readonly string[], create: boolean): any => {
    let current = out
    // Own keys only: `__proto__` and friends would reach Object.prototype.
    if (path.some(key => SKIP_KEYS.has(key))) {
      if (create) throw new Error(`refusing to edit through the key ${path.find(key => SKIP_KEYS.has(key))}`)
      return undefined
    }
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(current, key) || !isObj(current[key])) {
        if (!create) return undefined
        current[key] = {}
      }
      current = current[key]
    }
    return current
  }
  for (const draft of drafts) {
    const { ops, prune } = draftOps(out, draft)
    for (const op of ops) {
      if ("remove" in op) delete parentOf(op.remove, false)?.[op.remove[op.remove.length - 1]]
      else parentOf(op.set, true)[op.set[op.set.length - 1]] = cloneValue(op.value)
    }
    for (const path of prune) if (emptyObject(pathValue(out, path))) delete parentOf(path, false)?.[path[path.length - 1]]
  }
  return out
}

export type SaveResult =
  | { status: "saved"; text: string; count: number; backup?: string }
  | { status: "external-change" }
  | { status: "error"; message: string }

/** Write drafts to the config file. `openedText` (the file as the editor read
 * it) guards against silently overwriting an edit made meanwhile; the result
 * must parse, the previous file is kept as `.bak`, a missing file is created. */
export function saveConfig(options: { path: string; openedText?: string; drafts: readonly EditorDraft[]; confirmExternal?: boolean; backup?: boolean }): SaveResult {
  const { path, openedText, drafts } = options
  let current: string | undefined
  try {
    current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  } catch (error) {
    return { status: "error", message: `cannot read ${path}: ${errorText(error)}` }
  }
  if (current !== openedText && !options.confirmExternal) return { status: "external-change" }
  let next: string
  try {
    next = applyDrafts(current ?? "{\n}\n", drafts)
    parseJsonc(next)
  } catch (error) {
    return { status: "error", message: `refusing to write ${path}: ${errorText(error)}` }
  }
  // `backup: false` keeps an existing .bak, e.g. the file as it was before an
  // editor session's first save.
  const backup = current !== undefined && options.backup !== false
  try {
    if (current === undefined) mkdirSync(dirname(path), { recursive: true })
    else if (backup) copyFileSync(path, `${path}.bak`)
    writeFileSync(path, next, "utf8")
  } catch (error) {
    return { status: "error", message: `cannot write ${path}: ${errorText(error)}` }
  }
  return { status: "saved", text: next, count: drafts.length, ...(backup ? { backup: `${path}.bak` } : {}) }
}

export type EditorNode = {
  section: Section
  name: string
  /** `section:name`; stable across edits. */
  key: string
  label: string
  description: string
  /** OMO's builtin chain for this node in the installed build, if it has one. */
  builtin?: { display: string[]; models: string[] }
  base?: Override
  profile?: Override
  effective: { display: string[]; models: string[]; source: string }
  /** Absent from a readable builtin table: a node only the user defines. */
  userOnly: boolean
  readOnly?: string
}

/** Every routing node the editor lists: the selected main profile, then the
 * categories and agents that are builtin or configured in either layer, each
 * with its builtin chain, both layers' overrides and the effective chain. */
export function editorNodes(input: { raw: any; profile?: string; builtin: BuiltinRouting }): EditorNode[] {
  const { raw, profile, builtin } = input
  const defaults = builtin.status === "loaded" ? builtin.defaults : undefined
  const baseline = defaults ? resolveRouting({}, builtin) : undefined
  const resolved = resolveRouting(applyProfile(raw, profile).config, builtin)
  const node = (section: Section, name: string, label: string): EditorNode => {
    const builtinDisplay = baseline && Object.hasOwn(baseline.display[section], name) ? baseline.display[section][name] : undefined
    const configured = (resolved.config as any)[section]?.[name]
    return {
      section, name, key: `${section}:${name}`, label,
      description: summarize(configured?.description ?? configured?.display_name ?? defaults?.descriptions[section][name], 160) || EMPTY_CELL,
      ...(builtinDisplay ? { builtin: { display: builtinDisplay, models: (baseline?.config as any)[section]?.[name]?.models ?? [] } } : {}),
      base: overrideOf(section, layerEntry(raw, {}, section, name)),
      ...(profile === undefined ? {} : { profile: overrideOf(section, layerEntry(raw, { profile }, section, name)) }),
      effective: { display: resolved.display[section][name] ?? [], models: configured?.models ?? [], source: resolved.sources[section][name] ?? "unresolved" },
      userOnly: defaults !== undefined && !(section in defaults.unavailable) && !builtinDisplay,
    }
  }
  const fixedMain = (text: string): EditorNode => ({
    section: "model_profiles", name: "", key: "main", label: "main", description: EMPTY_CELL,
    effective: { display: resolved.mainChain, models: [], source: "configured pin" }, userOnly: false, readOnly: text,
  })
  const selection = resolved.mainSelection
  const nodes: EditorNode[] = [
    !selection ? fixedMain("model_profile이 설정되지 않았습니다: 메인 세션은 OMO 기본 동작을 따릅니다 (이 편집기는 선택 자체는 바꾸지 않음)")
      : selection.includes("/") ? fixedMain(`model_profile이 모델을 직접 고정합니다: ${selection}`)
      : node("model_profiles", selection, `main (${selection})`),
  ]
  for (const section of ["categories", "agents"] as const)
    for (const name of Object.keys(resolved.display[section]).sort()) nodes.push(node(section, name, name))
  return nodes
}

/** The state word of a node while editing a layer (`profile` undefined = base). */
export function nodeState(node: EditorNode, profile?: string): string {
  if (node.readOnly) return "-"
  if (node.effective.source === "disabled") return "비활성"
  if ((profile === undefined ? node.base : node.profile)?.chain) return "커스텀"
  if (profile !== undefined && node.base?.chain) return "base"
  return node.builtin ? "빌트인" : "없음"
}

/** The chain an edit starts from in a layer: the layer's own chain when it has
 * one, else what it inherits (base, then OMO's builtin) without the rungs of
 * unconnected providers unless `showHidden`. */
export function workingChain(node: EditorNode, profile: string | undefined, availability: Availability, showHidden: boolean): string[] {
  const own = profile === undefined ? node.base : node.profile
  // A category with only fallback_models runs builtin primary + those + builtin rungs.
  const merged = node.effective.source === "configured + builtin"
  if (own?.chain?.length && !merged) return [...own.chain]
  const inherited = merged ? node.effective.models
    : profile !== undefined && node.base?.chain?.length ? node.base.chain : node.builtin?.models ?? []
  return showHidden ? [...inherited] : inherited.filter(spec => rungView(spec, availability).visible)
}

/** Problems in a candidate list: adjacent rungs that differ only in effort
 * (limits are per account, so they are no fallback), ids the connected
 * providers do not list, and a list with no connected candidate at all. */
export function chainWarnings(chain: readonly string[], availability: Availability): string[] {
  const out: string[] = []
  chain.forEach((spec, index) => {
    const here = splitSpec(spec)
    const next = index + 1 < chain.length ? splitSpec(chain[index + 1]) : undefined
    if (here && next && here.model === next.model && here.providers.join("|") === next.providers.join("|") && here.effort !== next.effort)
      out.push(`${index + 1}·${index + 2}번: 같은 모델 ${here.model}의 effort만 다릅니다 (한도가 계정 단위라 폴백 효과가 없음)`)
    if (rungView(spec, availability).unknown) out.push(`${index + 1}번: ${spec}은 연결된 모델 목록에 없습니다`)
  })
  if (chain.length && availability.known && !chain.some(spec => rungView(spec, availability).visible))
    out.push("연결된 후보가 하나도 없어 이 노드는 실행되지 않습니다")
  return out
}

/** Warnings for a node's effective chain; OMO's own builtin chains are only
 * checked for having no connected candidate. */
export function nodeWarnings(node: EditorNode, availability: Availability): string[] {
  if (node.readOnly || node.effective.source === "disabled") return []
  const warnings = chainWarnings(node.effective.models, availability)
  return node.effective.source === "configured" || node.effective.source === "configured + builtin"
    ? warnings : warnings.filter(warning => warning.startsWith("연결된 후보"))
}

/** The builtin routing a user last reviewed, kept beside omo.jsonc. */
export type Snapshot = { version: 1; omo?: string; reviewedAt: string; sections: Partial<Record<Section, Record<string, string[]>>> }
export type DriftEntry = { kind: "new" | "changed" | "removed"; before?: string[]; after?: string[] }
export type Drift = { since?: string; count: number; sections: Partial<Record<Section, Record<string, DriftEntry>>> }

export const snapshotPath = (home: string): string => join(home, ".omo", "routing-builtin-snapshot.json")

/** The installed OMO version, from the package the launcher belongs to. */
export function omoVersion(env: Record<string, string | undefined>): string | undefined {
  if (!env.OMO_BIN) return undefined
  try {
    const version = JSON.parse(readFileSync(join(dirname(env.OMO_BIN), "..", "package.json"), "utf8")).version
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

/** The installed builtin routing as display chains. Sections the loader could
 * not read are left out, so they are never compared or overwritten. */
export function builtinSnapshot(builtin: BuiltinRouting, omo?: string, now = new Date()): Snapshot {
  const sections: Snapshot["sections"] = {}
  if (builtin.status === "loaded") {
    const { defaults } = builtin
    const baseline = resolveRouting({}, builtin)
    if (!("categories" in defaults.unavailable)) sections.categories = { ...baseline.display.categories }
    if (!("agents" in defaults.unavailable)) {
      const names = [...new Set([...Object.keys(defaults.agents), ...Object.keys(defaults.agentCategories)])].sort()
      sections.agents = Object.fromEntries(names.map(name => [name, [
        ...(defaults.agents[name] ? builtinDisplay(defaults.agents[name]) : []),
        ...(defaults.agentCategories[name] ? [`categories: ${defaults.agentCategories[name].join(", ")}`] : []),
      ]]))
    }
    if (!("model_profiles" in defaults.unavailable))
      sections.model_profiles = Object.fromEntries(Object.entries(defaults.model_profiles).map(([name, chain]) => [name, builtinDisplay(chain)]))
  }
  return { version: 1, ...(omo ? { omo } : {}), reviewedAt: now.toISOString(), sections }
}

/** What changed between the reviewed snapshot and the installed build, for
 * sections both could read. */
export function snapshotDrift(reviewed: Snapshot, current: Snapshot): Drift {
  const drift: Drift = { ...(reviewed.omo ? { since: reviewed.omo } : {}), count: 0, sections: {} }
  for (const section of SECTIONS) {
    const before = reviewed.sections[section]
    const after = current.sections[section]
    if (!before || !after) continue
    const entries: Record<string, DriftEntry> = {}
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = Object.hasOwn(before, name) ? before[name] : undefined
      const b = Object.hasOwn(after, name) ? after[name] : undefined
      const kind = !a ? "new" : !b ? "removed" : JSON.stringify(a) !== JSON.stringify(b) ? "changed" : undefined
      if (kind) entries[name] = { kind, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) }
    }
    if (Object.keys(entries).length) {
      drift.sections[section] = entries
      drift.count += Object.keys(entries).length
    }
  }
  return drift
}

/** The new review baseline: the current build, keeping previously reviewed
 * sections the current build could not read. */
export const mergeSnapshot = (reviewed: Snapshot | undefined, current: Snapshot): Snapshot =>
  ({ ...current, sections: { ...reviewed?.sections, ...current.sections } })

/** The stored snapshot, or undefined when absent or not a snapshot. */
export function readSnapshot(path: string): Snapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (!record(value) || value.version !== 1 || !record(value.sections)) return undefined
    for (const [section, entries] of Object.entries(value.sections))
      if (!SECTIONS.includes(section as Section) || !record(entries) || !Object.values(entries).every(strings)) return undefined
    return value as Snapshot
  } catch {
    return undefined
  }
}

export function writeSnapshot(path: string, snapshot: Snapshot): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

const driftName = (section: Section, name: string): string =>
  section === "categories" ? name : section === "agents" ? `agent:${name}` : `main:${name}`
const driftNames = (drift: Drift, kind: DriftEntry["kind"]): string[] =>
  SECTIONS.flatMap(section => Object.entries(drift.sections[section] ?? {})
    .filter(([, entry]) => entry.kind === kind).map(([name]) => driftName(section, name)))

/** The report's one-line summary of builtin changes since the last review. */
export function driftLine(drift: Drift): string {
  const parts = (["new", "changed", "removed"] as const).flatMap(kind => {
    const names = driftNames(drift, kind)
    return names.length ? [`${kind} ${names.length} (${names.join(", ")})`] : []
  })
  return `builtin changes since last review${drift.since ? ` (reviewed on OMO ${drift.since})` : ""}: ${parts.join(", ")}; /routing edit to review`
}

export type ProjectConfig = { path: string; dir: string; problem?: string }

const hasRouting = (config: any): boolean => isObj(config) && (
  ["categories", "agents", "model_profile", "model_profiles"].some(key => Object.hasOwn(config, key))
  || ["[native]", "[senpi]"].some(key => hasRouting(config[key]))
  || (isObj(config.profiles) && Object.values(config.profiles).some(hasRouting)))

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Project configs OMO also merges for sessions started in `cwd`: the
 * `.omo/omo.jsonc` (else `omo.json`) of `cwd` and each parent up to, not
 * including, `home`; symlinks are skipped as OMO skips them. Only files that
 * set routing (or cannot be read) are returned. */
export function projectConfigs(cwd: string, home: string): ProjectConfig[] {
  const same = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
  const stop = resolve(home)
  const found: ProjectConfig[] = []
  let dir = resolve(cwd)
  for (let depth = 0; depth < 256 && !same(dir, stop); depth++) {
    const omo = join(dir, ".omo")
    const file = isLink(omo) ? undefined : ["omo.jsonc", "omo.json"].map(name => join(omo, name)).find(path => {
      try {
        return lstatSync(path).isFile()
      } catch {
        return false
      }
    })
    if (file) {
      try {
        if (hasRouting(parseJsonc(readFileSync(file, "utf8")))) found.push({ path: file, dir })
      } catch (error) {
        found.push({ path: file, dir, problem: errorText(error) })
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

export const projectNotice = (config: ProjectConfig, korean = false): string => config.problem === undefined
  ? korean ? `프로젝트 설정 ${config.path}도 라우팅을 정합니다: ${config.dir} 아래에서 시작한 세션에서는 이 설정이 ~/.omo/omo.jsonc 위에 덮입니다`
    : `project config ${config.path} also sets routing; OMO merges it over ~/.omo/omo.jsonc in sessions started under ${config.dir}`
  : korean ? `프로젝트 설정 ${config.path}을 읽지 못했습니다 (${config.problem}): 라우팅을 정한다면 OMO가 적용합니다`
    : `project config ${config.path} could not be read (${config.problem}); if it sets routing, OMO applies it`

const RAW_KEYS: Record<string, string> = {
  "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down",
  "\x1b[C": "right", "\x1bOC": "right", "\x1b[D": "left", "\x1bOD": "left",
  "\x1b[1;2A": "shift-up", "\x1b[1;2B": "shift-down",
  "\x1b[5~": "pgup", "\x1b[6~": "pgdn",
  "\x1b[H": "home", "\x1bOH": "home", "\x1b[1~": "home", "\x1b[F": "end", "\x1bOF": "end", "\x1b[4~": "end",
  // No "\b": legacy terminals send it for ctrl+Backspace.
  "\r": "enter", "\n": "enter", "\x1b": "esc", "\t": "tab", "\x7f": "backspace", "\x1b[3~": "delete",
}
const SELECT_BINDINGS = [
  ["tui.select.up", "up"], ["tui.select.down", "down"], ["tui.select.pageUp", "pgup"],
  ["tui.select.pageDown", "pgdn"], ["tui.select.confirm", "enter"], ["tui.select.cancel", "esc"],
] as const
const CSI_U_KEYS: Record<number, string> = { 8: "backspace", 9: "tab", 13: "enter", 27: "esc", 127: "backspace" }

type KeyMatcher = { matches?(data: string, id: string): boolean }

/** One key press as the editor names it (`up`, `enter`, `ch:a`, ...), from legacy,
 * xterm or kitty (CSI u) sequences; the host's select keybindings count too.
 * Printable keys held with ctrl/alt/super are ignored, never read as letters. */
export function decodeKey(data: string, keybindings?: KeyMatcher): string | undefined {
  if (Object.hasOwn(RAW_KEYS, data)) return RAW_KEYS[data]
  for (const [id, key] of SELECT_BINDINGS) {
    try {
      if (keybindings?.matches?.(data, id)) return key
    } catch {
      // a host without that binding id
    }
  }
  // kitty CSI u (`code;mods u`) and xterm modifyOtherKeys (`27;mods;code ~`).
  const csi = data.startsWith("\x1b[27;") ? /^(\d+);(\d+)~$/.exec(data.slice(5))?.slice(1).reverse()
    : data.startsWith("\x1b[") ? /^(\d+)(?::\d+)*(?:;(\d+)(?::\d+)*)?u$/.exec(data.slice(2))?.slice(1) : undefined
  if (csi) {
    const code = Number(csi[0])
    const modifiers = Number(csi[1] ?? "1") - 1
    // Held ctrl/alt/super never edit: ctrl+Backspace is not Backspace.
    if ((modifiers & ~1) !== 0) return undefined
    if (CSI_U_KEYS[code]) return CSI_U_KEYS[code]
    if (code < 32) return undefined
    const char = String.fromCodePoint(code)
    return `ch:${modifiers & 1 ? char.toUpperCase() : char}`
  }
  return [...data].length === 1 && data >= " " ? `ch:${data}` : undefined
}

/** Exactly `width` terminal cells: padded with spaces, or cut with `…`. */
export function fitCells(text: string, width: number): string {
  if (width <= 0) return ""
  const cells = displayWidth(text)
  if (cells <= width) return text + " ".repeat(width - cells)
  let out = ""
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const size = graphemeWidth(segment)
    if (used + size > width - 1) break
    out += segment
    used += size
  }
  return `${out}…${" ".repeat(Math.max(0, width - used - 1))}`
}
const padCells = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - displayWidth(text)))

type Painter = { fg?(color: string, text: string): string; bold?(text: string): string }
type Tone = "info" | "success" | "warning" | "error"
type Confirm = "discard" | "external" | undefined
type ChainMode = { kind: "chain"; key: string; cursor: number }
type PickerMode = { kind: "picker"; key: string; rung: number; add: boolean; filter: string; pick: number }
type EffortMode = { kind: "effort"; key: string; rung: number; action: "add" | "replace" | "effort"; provider: string; model: string; options: string[]; pick: number }
type EditorMode = { kind: "list" } | ChainMode | PickerMode | EffortMode
type Item = { text: string; color?: string; bold?: boolean; header?: boolean }

const NO_EFFORT = "(없음)"
const TONES: Record<Tone, string> = { info: "accent", success: "success", warning: "warning", error: "error" }
/** Overlay placement for ctx.ui.custom; the component lays itself out to the
 * same height. Not full height: omo renders inline below the shell prompt, so
 * until a session fills the terminal the top rows of the frame are off-screen,
 * and a centered overlay needs that much room above it (history search uses 80% too). */
export const EDITOR_OVERLAY = { width: "96%", maxHeight: "80%", minWidth: 40, margin: 1 } as const
const EDITOR_HEIGHT = 0.8
const draftKey = (profile: string | undefined, section: Section, name: string): string => `${profile ?? ""}\u0000${section}\u0000${name}`

export type EditorOptions = {
  /** The parsed config as opened (or `{}` when there is no file). */
  raw: any
  builtin: BuiltinRouting
  availability: Availability
  /** The profile layer, when one is edited besides base; the editor opens on it. */
  profile?: string
  omo?: string
  drift?: Drift
  warnings?: readonly string[]
  configPath?: string
  levels?: (model: ModelInfo | undefined) => string[]
  save: (drafts: EditorDraft[], confirmExternal: boolean) => SaveResult
  markReviewed?: () => Drift
  done: (result: { saved: number }) => void
  rows?: () => number
  requestRender?: () => void
}

/** The `/routing edit` overlay: a pi-tui component (render/handleInput/
 * invalidate). It never touches files itself: saving and marking the builtin
 * reviewed go through the callbacks. */
export class RoutingEditor {
  private readonly options: EditorOptions
  private readonly theme: Painter | undefined
  private readonly keybindings: KeyMatcher | undefined
  private raw: any
  private readonly drafts = new Map<string, EditorDraft>()
  private layer: string | undefined
  private showHidden = false
  private mode: EditorMode = { kind: "list" }
  private cursor = 0
  private readonly scrolls: Record<string, number> = {}
  private listRows = 10
  private message: { text: string; tone: Tone } | undefined
  private confirm: Confirm
  private saved = 0
  private drift: Drift | undefined
  private version = 0
  private cache: { version: number; nodes: EditorNode[] } | undefined

  constructor(options: EditorOptions, theme?: Painter, keybindings?: KeyMatcher) {
    this.options = options
    this.theme = theme
    this.keybindings = keybindings
    this.raw = isObj(options.raw) ? options.raw : {}
    this.layer = options.profile
    this.drift = options.drift
  }

  invalidate(): void {
    this.cache = undefined
  }

  /** Staged drafts, in the order they were made. */
  pending(): EditorDraft[] {
    return [...this.drafts.values()]
  }

  handleInput(data: string): void {
    const mode = this.mode
    if (mode.kind === "picker" && [...data].length > 1 && [...data].every(char => char >= " " && char !== "\x7f")) {
      mode.filter += data // pasted text
      mode.pick = 0
    } else {
      const key = decodeKey(data, this.keybindings)
      if (key !== undefined) this.dispatch(key)
    }
    this.options.requestRender?.()
  }

  private dispatch(key: string): void {
    const confirm = this.confirm
    this.confirm = undefined
    this.message = undefined
    const mode = this.mode
    if (mode.kind === "list") this.listKey(key, confirm)
    else if (mode.kind === "chain") this.chainKey(key, mode, confirm)
    else if (mode.kind === "picker") this.pickerKey(key, mode)
    else this.effortKey(key, mode)
  }

  private nodes(): EditorNode[] {
    if (this.cache?.version === this.version) return this.cache.nodes
    const raw = this.drafts.size ? applyDraftsToConfig(this.raw, this.pending()) : this.raw
    const nodes = editorNodes({ raw, profile: this.options.profile, builtin: this.options.builtin })
    this.cache = { version: this.version, nodes }
    return nodes
  }

  private changed(): void {
    this.version++
    this.cache = undefined
  }

  private node(key: string): EditorNode | undefined {
    return this.nodes().find(node => node.key === key)
  }

  private editChain(node: EditorNode): string[] {
    return workingChain(node, this.layer, this.options.availability, this.showHidden)
  }

  /** Whether dropping this layer's chain leaves something to follow. */
  private canFollow(node: EditorNode): boolean {
    return node.builtin !== undefined || (this.layer !== undefined && !!node.base?.chain?.length)
  }

  private say(text: string, tone: Tone = "info"): void {
    this.message = { text, tone }
  }

  private layerLabel(): string {
    return this.layer === undefined ? "base" : `profile ${this.layer}`
  }

  private dirty(node: EditorNode): boolean {
    return this.drafts.has(draftKey(undefined, node.section, node.name))
      || (this.options.profile !== undefined && this.drafts.has(draftKey(this.options.profile, node.section, node.name)))
  }

  private driftOf(node: EditorNode): DriftEntry | undefined {
    const entries = this.drift?.sections[node.section]
    return entries && Object.hasOwn(entries, node.name) ? entries[node.name] : undefined
  }

  /** Stage a change for the current layer; a draft that ends up equal to what
   * the layer already says is dropped. */
  private stage(node: EditorNode, change: { chain?: string[] | null; disable?: boolean | null }): void {
    const key = draftKey(this.layer, node.section, node.name)
    const original = overrideOf(node.section, layerEntry(this.raw, { profile: this.layer }, node.section, node.name))
    const draft: EditorDraft = {
      ...(this.drafts.get(key) ?? {
        ...(this.layer === undefined ? {} : { profile: this.layer }),
        section: node.section, name: node.name, disable: original?.disable ?? null,
      }),
      ...change,
    }
    if (Array.isArray(draft.chain) && !draft.chain.length) draft.chain = null
    const sameChain = draft.chain === undefined
      || (draft.chain === null ? !original?.chain : JSON.stringify(draft.chain) === JSON.stringify(original?.chain))
    if (sameChain && (draft.disable ?? undefined) === original?.disable) this.drafts.delete(key)
    else this.drafts.set(key, draft)
    this.changed()
  }

  private updateChain(node: EditorNode, next: string[]): boolean {
    if (!next.length && !this.canFollow(node)) {
      this.say("빌트인 기본값이 없는 노드라 마지막 모델은 지울 수 없습니다", "warning")
      return false
    }
    this.stage(node, { chain: next.length ? next : null })
    return true
  }

  private follow(node: EditorNode): void {
    if (node.readOnly) {
      this.say(node.readOnly, "warning")
      return
    }
    if (!this.canFollow(node)) {
      this.say("빌트인 기본값이 없는 노드라 따를 대상이 없습니다", "warning")
      return
    }
    this.stage(node, { chain: null })
    this.say(this.layer !== undefined && node.base?.chain?.length
      ? `${node.label}: 이 레이어의 체인을 지웁니다, base 설정을 따릅니다`
      : `${node.label}: 이 레이어의 체인을 지웁니다, OMO 빌트인 기본값을 따릅니다 (업데이트도 따라감)`)
  }

  private toggleDisable(node: EditorNode): void {
    if (node.readOnly || node.section === "model_profiles") {
      this.say("main은 비활성화할 수 없습니다", "warning")
      return
    }
    const disabled = node.effective.source === "disabled"
    if (disabled && this.layer === undefined && node.profile?.disable === true) {
      this.say(`profile ${this.options.profile}에서 비활성화되어 있습니다: Tab으로 그 레이어로 가서 바꾸세요`, "warning")
      return
    }
    const lower = this.layer !== undefined && node.base?.disable === true
    this.stage(node, { disable: disabled ? (lower ? false : null) : true })
    this.say(`${node.label}: ${disabled ? "다시 사용" : "비활성화"}`)
  }

  private undo(node: EditorNode): void {
    if (!this.drafts.delete(draftKey(this.layer, node.section, node.name))) {
      this.say("이 레이어에서 취소할 변경이 없습니다")
      return
    }
    this.changed()
    this.say(`${node.label}: ${this.layerLabel()} 변경을 취소했습니다`)
  }

  private toggleHidden(): void {
    this.showHidden = !this.showHidden
    this.say(`미연결 프로바이더 후보를 ${this.showHidden ? "표시합니다" : "숨깁니다"}`)
  }

  private switchLayer(): void {
    if (this.options.profile === undefined) {
      this.say("편집할 프로필이 없어 base만 편집합니다")
      return
    }
    this.layer = this.layer === undefined ? this.options.profile : undefined
    this.changed()
    this.say(`편집 레이어: ${this.layerLabel()}`)
  }

  private markReviewed(): void {
    if (!this.drift?.count || !this.options.markReviewed) {
      this.say("확인할 빌트인 변경이 없습니다")
      return
    }
    try {
      this.drift = this.options.markReviewed()
    } catch (error) {
      this.say(`스냅샷을 쓰지 못했습니다: ${errorText(error)}`, "error")
      return
    }
    this.say("빌트인 변경을 확인 처리했습니다: 다음 비교 기준이 지금 설치된 OMO가 됩니다", "success")
  }

  private save(confirmed: boolean): void {
    const drafts = this.pending()
    if (!drafts.length) {
      this.say("저장할 변경이 없습니다")
      return
    }
    let result: SaveResult
    try {
      result = this.options.save(drafts, confirmed)
    } catch (error) {
      this.say(`저장하지 못했습니다: ${errorText(error)}`, "error")
      return
    }
    if (result.status === "external-change") {
      this.confirm = "external"
      this.say("omo.jsonc가 편집기를 연 뒤 바뀌었습니다. s를 한 번 더 누르면 지금 파일에 이 변경을 적용합니다 (다른 키: 취소)", "warning")
      return
    }
    if (result.status === "error") {
      this.say(result.message, "error")
      return
    }
    this.raw = parseJsonc(result.text)
    this.drafts.clear()
    this.saved += result.count
    this.changed()
    this.say(`저장했습니다: ${result.count}건 → ${this.options.configPath ?? "omo.jsonc"}${result.backup ? " (이전 파일은 .bak)" : ""}. /reload 하면 적용됩니다`, "success")
  }

  private close(confirmed: boolean): void {
    if (this.drafts.size && !confirmed) {
      this.confirm = "discard"
      this.say(`저장 안 된 변경 ${this.drafts.size}건: q/Esc를 한 번 더 누르면 버리고 닫습니다 (s: 저장)`, "warning")
      return
    }
    this.options.done({ saved: this.saved })
  }

  private listKey(key: string, confirm: Confirm): void {
    const nodes = this.nodes()
    const node = nodes[this.cursor]
    const last = Math.max(0, nodes.length - 1)
    const page = Math.max(1, this.listRows - 2)
    switch (key) {
      case "up": this.cursor = Math.max(0, this.cursor - 1); return
      case "down": this.cursor = Math.min(last, this.cursor + 1); return
      case "pgup": this.cursor = Math.max(0, this.cursor - page); return
      case "pgdn": this.cursor = Math.min(last, this.cursor + page); return
      case "home": this.cursor = 0; return
      case "end": this.cursor = last; return
      case "enter": case "right":
        if (!node) return
        if (node.readOnly) {
          this.say(node.readOnly, "warning")
          return
        }
        this.mode = { kind: "chain", key: node.key, cursor: 0 }
        return
      case "ch:r": if (node) this.follow(node); return
      case "ch:x": if (node) this.toggleDisable(node); return
      case "ch:u": if (node) this.undo(node); return
      case "ch:h": this.toggleHidden(); return
      case "tab": this.switchLayer(); return
      case "ch:c": this.markReviewed(); return
      case "ch:s": this.save(confirm === "external"); return
      case "ch:q": case "esc": this.close(confirm === "discard"); return
    }
  }

  private chainKey(key: string, mode: ChainMode, confirm: Confirm): void {
    const node = this.node(mode.key)
    if (!node) {
      this.mode = { kind: "list" }
      return
    }
    const chain = this.editChain(node)
    const last = chain.length
    const swap = (to: number): void => {
      const from = mode.cursor
      if (from >= last || to < 0 || to >= last) return
      const next = [...chain]
      ;[next[from], next[to]] = [next[to], next[from]]
      if (this.updateChain(node, next)) mode.cursor = to
    }
    switch (key) {
      case "up": mode.cursor = Math.max(0, mode.cursor - 1); return
      case "down": mode.cursor = Math.min(last, mode.cursor + 1); return
      case "home": case "pgup": mode.cursor = 0; return
      case "end": case "pgdn": mode.cursor = last; return
      case "enter": this.openPicker(node, mode, mode.cursor >= last); return
      case "ch:a": this.openPicker(node, mode, true); return
      case "ch:e": if (mode.cursor < last) this.openEffort(node, mode.cursor, "effort", chain[mode.cursor]); return
      case "ch:d": case "delete": case "backspace": {
        if (mode.cursor >= last) return
        const next = chain.filter((_, index) => index !== mode.cursor)
        if (this.updateChain(node, next)) {
          this.say(`${labelSpec(chain[mode.cursor])} 삭제${next.length ? "" : ": 이제 기본값을 따릅니다"}`)
          mode.cursor = Math.max(0, Math.min(mode.cursor, next.length - 1))
        }
        return
      }
      case "ch:K": case "shift-up": swap(mode.cursor - 1); return
      case "ch:J": case "shift-down": swap(mode.cursor + 1); return
      case "ch:b": {
        const models = node.builtin?.models ?? []
        if (!models.length) {
          this.say("이 노드에는 OMO 빌트인 체인이 없습니다", "warning")
          return
        }
        const next = this.showHidden ? models : models.filter(spec => rungView(spec, this.options.availability).visible)
        if (!next.length) {
          this.say("연결된 빌트인 후보가 없습니다 (h: 미연결 후보 보기)", "warning")
          return
        }
        if (this.updateChain(node, [...next])) {
          mode.cursor = 0
          this.say("빌트인 체인을 복사했습니다: 이렇게 고정하면 OMO 업데이트를 따라가지 않습니다 (따라가려면 r)", "warning")
        }
        return
      }
      case "ch:r": this.follow(node); this.mode = { kind: "list" }; return
      case "ch:x": this.toggleDisable(node); return
      case "ch:h": this.toggleHidden(); return
      case "ch:u": this.undo(node); mode.cursor = 0; return
      case "ch:s": this.save(confirm === "external"); return
      case "esc": case "left": case "ch:q": this.mode = { kind: "list" }; return
    }
  }

  private pickerModels(filter: string): ModelInfo[] {
    const { availability } = this.options
    const order = (provider: string): number => availability.providers.indexOf(provider)
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
    return [...availability.models.values()]
      .sort((a, b) => order(a.provider) - order(b.provider) || a.id.localeCompare(b.id))
      .filter(model => {
        const text = `${model.provider}/${model.id} ${labelProvider(model.provider)}/${model.id} ${model.name}`.toLowerCase()
        return words.every(word => text.includes(word))
      })
  }

  private openPicker(node: EditorNode, mode: ChainMode, add: boolean): void {
    const { availability } = this.options
    if (!availability.known) {
      this.say(`연결된 모델 목록이 없어 새 모델을 고를 수 없습니다 (${availability.reason}); 삭제·순서·effort는 바꿀 수 있습니다`, "warning")
      return
    }
    const models = this.pickerModels("")
    if (!models.length) {
      this.say("이 세션에 연결된 모델이 없습니다", "warning")
      return
    }
    const current = add ? undefined : splitSpec(this.editChain(node)[mode.cursor] ?? "")
    const pick = current ? models.findIndex(model => current.providers.includes(model.provider) && model.id === current.model) : -1
    this.scrolls.picker = 0
    this.mode = { kind: "picker", key: node.key, rung: mode.cursor, add, filter: "", pick: Math.max(0, pick) }
  }

  private pickerKey(key: string, mode: PickerMode): void {
    const models = this.pickerModels(mode.filter)
    const last = Math.max(0, models.length - 1)
    switch (key) {
      case "up": mode.pick = Math.max(0, mode.pick - 1); return
      case "down": mode.pick = Math.min(last, mode.pick + 1); return
      case "pgup": mode.pick = Math.max(0, mode.pick - 10); return
      case "pgdn": mode.pick = Math.min(last, mode.pick + 10); return
      case "home": mode.pick = 0; return
      case "end": mode.pick = last; return
      case "esc": this.mode = { kind: "chain", key: mode.key, cursor: mode.rung }; return
      case "backspace": mode.filter = [...mode.filter].slice(0, -1).join(""); mode.pick = 0; return
      case "enter": {
        const model = models[mode.pick]
        const node = this.node(mode.key)
        if (!model || !node) {
          this.say("필터와 맞는 모델이 없습니다", "warning")
          return
        }
        this.openEffort(node, mode.rung, mode.add ? "add" : "replace", joinSpec(model.provider, model.id))
        return
      }
      default:
        if (key.startsWith("ch:")) {
          mode.filter += key.slice(3)
          mode.pick = 0
        }
    }
  }

  private openEffort(node: EditorNode, rung: number, action: EffortMode["action"], spec: string): void {
    const parts = splitSpec(spec)
    if (!parts) {
      this.say(`${spec}: provider/model 형식이 아닙니다`, "error")
      return
    }
    const provider = parts.providers[0]
    const levels = (this.options.levels ?? (model => effortLevels(model)))(this.options.availability.models.get(`${provider}/${parts.model}`))
    const current = action === "add" ? undefined : splitSpec(this.editChain(node)[rung] ?? "")?.effort
    const options = [NO_EFFORT, ...levels, ...(current && !levels.includes(current) ? [current] : [])]
    // A new rung starts at high when the model offers it, else at no suffix.
    const wanted = current ?? (action === "add" && levels.includes("high") ? "high" : undefined)
    this.mode = { kind: "effort", key: node.key, rung, action, provider, model: parts.model, options, pick: Math.max(0, options.indexOf(wanted ?? NO_EFFORT)) }
  }

  private effortKey(key: string, mode: EffortMode): void {
    switch (key) {
      case "up": mode.pick = Math.max(0, mode.pick - 1); return
      case "down": mode.pick = Math.min(mode.options.length - 1, mode.pick + 1); return
      case "home": case "pgup": mode.pick = 0; return
      case "end": case "pgdn": mode.pick = mode.options.length - 1; return
      case "esc": case "left": this.mode = { kind: "chain", key: mode.key, cursor: mode.rung }; return
      case "enter": this.applyEffort(mode); return
    }
  }

  private applyEffort(mode: EffortMode): void {
    const back: ChainMode = { kind: "chain", key: mode.key, cursor: mode.rung }
    this.mode = back
    const node = this.node(mode.key)
    if (!node) return
    const choice = mode.options[mode.pick]
    const spec = joinSpec(mode.provider, mode.model, choice === NO_EFFORT ? undefined : choice)
    const chain = this.editChain(node)
    const existing = chain.indexOf(spec)
    if (mode.action !== "add" && chain[mode.rung] === spec) return
    if (existing >= 0) {
      back.cursor = existing
      this.say(`${labelSpec(spec)}은 이미 ${existing + 1}번째에 있습니다`, "warning")
      return
    }
    if (mode.action === "add") {
      const at = mode.rung < chain.length ? mode.rung + 1 : chain.length
      if (this.updateChain(node, [...chain.slice(0, at), spec, ...chain.slice(at)])) {
        back.cursor = at
        this.say(`${at + 1}번에 ${labelSpec(spec)} 추가`, "success")
      }
      return
    }
    if (this.updateChain(node, chain.map((item, index) => (index === mode.rung ? spec : item))))
      this.say(`${mode.rung + 1}번: ${labelSpec(spec)}`, "success")
  }

  /** Header, the list (or the chain, picker, effort view), the selected node's
   * details and the key help, each line exactly `width` cells wide and the whole
   * view within the overlay height. */
  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width))
    const nodes = this.nodes()
    this.cursor = Math.max(0, Math.min(this.cursor, nodes.length - 1))
    if (this.mode.kind !== "list" && !this.node(this.mode.key)) this.mode = { kind: "list" }
    const mode = this.mode
    const focus = mode.kind === "list" ? nodes[this.cursor] : this.node(mode.key)
    const height = this.height()
    // The body keeps at least three rows: key help, then header notes give way.
    const header = this.headerItems(w)
    const keys = this.wrapped(this.keyHelp(), w, "dim")
    const status = this.statusItems(w)
    const fixed = (): number => header.length + keys.length + status.length + 1
    const keyLines = keys.length
    while (fixed() + 3 > height && keys.length > 1) keys.pop()
    if (keys.length < keyLines) keys[keys.length - 1] = { ...keys[keys.length - 1], text: `${keys[keys.length - 1].text.trimEnd()} …` }
    while (fixed() + 3 > height && header.length > 1) header.pop()
    const room = Math.max(3, height - fixed())
    const detail = mode.kind === "list" || mode.kind === "chain" ? this.detailItems(focus, w) : []
    let detailRows = Math.min(detail.length, Math.floor(room * 0.4), room - 4)
    if (detailRows < 2) detailRows = 0
    const bodyRows = room - (detailRows ? detailRows + 1 : 0)
    if (mode.kind === "list") this.listRows = bodyRows
    const body = mode.kind === "list" ? this.listItems(nodes)
      : mode.kind === "chain" ? this.chainItems(focus as EditorNode, mode)
      : mode.kind === "picker" ? this.pickerItems(mode) : this.effortItems(mode)
    const rule: Item = { text: "─".repeat(w), color: "borderMuted" }
    const shown = detail.length > detailRows ? [...detail.slice(0, detailRows - 1), { text: "  …", color: "dim" }] : detail
    return [
      ...[...header, rule].map(item => this.line(item, w)),
      ...this.window(body.items, body.focus, bodyRows, w, mode.kind),
      ...(detailRows ? [rule, ...shown] : []).map(item => this.line(item, w)),
      ...[...keys, ...status].map(item => this.line(item, w)),
    ]
  }

  private paint(color: string, text: string): string {
    try {
      return this.theme?.fg ? this.theme.fg(color, text) : text
    } catch {
      return text
    }
  }

  private line(item: Item, width: number): string {
    const text = fitCells(item.text, width)
    const bold = item.bold && this.theme?.bold ? this.theme.bold(text) : text
    return item.color ? this.paint(item.color, bold) : bold
  }

  private wrapped(text: string, width: number, color?: string): Item[] {
    return wrapText(text, width, width >= 8 ? "  " : "").map(line => ({ text: line, color }))
  }

  /** `rows` lines of `items`, scrolled so the focused item (and the section
   * title right above it) stays visible. */
  private window(items: Item[], focus: number, rows: number, width: number, key: string): string[] {
    let start = this.scrolls[key] ?? 0
    const top = focus > 0 && items[focus - 1]?.header ? focus - 1 : focus
    if (top < start) start = top
    if (focus >= start + rows) start = focus - rows + 1
    start = Math.max(0, Math.min(start, items.length - rows))
    this.scrolls[key] = start
    const out = items.slice(start, start + rows).map(item => this.line(item, width))
    while (out.length < rows) out.push(" ".repeat(width))
    return out
  }

  /** A chain for display: provider labels, groups narrowed to connected
   * providers, unconnected rungs dropped with a count (`hide`) or marked. */
  private chainText(specs: readonly string[], hide: boolean): string {
    const shown: string[] = []
    let hidden = 0
    for (const spec of specs) {
      const view = rungView(spec, this.options.availability)
      if (!view.visible && hide && !this.showHidden) hidden++
      else shown.push(view.visible ? labelSpec(connectedSpec(spec, view)) : `${labelSpec(spec)}(미연결)`)
    }
    const text = shown.length ? shown.join(" → ") : specs.length ? "(연결된 후보 없음)" : "(체인 없음)"
    return hidden ? `${text}  +${hidden} 숨김` : text
  }

  private overrideText(override: Override | undefined, fallback: string): string {
    if (!override || (!override.chain && override.disable === undefined)) return `설정 없음 (${fallback})`
    const parts: string[] = []
    if (override.chain) parts.push(override.chain.length ? this.chainText(override.chain, false) : "(빈 체인)")
    if (override.disable !== undefined) parts.push(`disable: ${override.disable}`)
    return parts.join(" · ")
  }

  private headerItems(width: number): Item[] {
    const { omo, profile, availability, warnings = [] } = this.options
    const section = harnessKey(layerObject(this.raw, { profile: this.layer }))
    const items: Item[] = [{
      text: `라우팅 편집${omo ? ` · OMO ${omo}` : ""} · 편집 레이어: ${this.layerLabel()}${section ? ` ${section}` : ""}${profile !== undefined ? " (Tab 전환)" : ""}`,
      color: "accent", bold: true,
    }]
    items.push(...this.wrapped(availability.known
      ? `연결된 프로바이더: ${availability.providers.map(labelProvider).join(", ") || "없음"} · 미연결 후보 ${this.showHidden ? "표시 중" : "숨김"} (h)`
      : `구독 정보를 읽지 못해 모든 후보를 표시합니다 (${availability.reason})`, width, availability.known ? "muted" : "warning"))
    // Builtin changes come before other notes: they are what a review is for.
    if (this.drift?.count) items.push(...this.wrapped(this.driftSummary(), width, "warning").slice(0, 3))
    const notes = warnings.flatMap(text => this.wrapped(`⚠ ${text}`, width, "warning"))
    items.push(...(notes.length > 4 ? [...notes.slice(0, 3), { text: `⚠ 경고가 더 있습니다 (${warnings.length}건)`, color: "warning" }] : notes))
    return items
  }

  private driftSummary(): string {
    const drift = this.drift as Drift
    const parts = ([["new", "신규"], ["changed", "변경"], ["removed", "제거"]] as const).flatMap(([kind, label]) => {
      const names = driftNames(drift, kind)
      return names.length ? [`${label} ${names.length} (${names.join(", ")})`] : []
    })
    return `빌트인 변경${drift.since ? ` (OMO ${drift.since}에서 확인한 뒤)` : ""}: ${parts.join(" · ")} · c: 확인 처리`
  }

  private keyHelp(): string {
    switch (this.mode.kind) {
      case "list":
        return ["↑↓ 이동", "Enter 체인 편집", "r 기본값 따르기", "x 비활성 전환", "u 변경 취소", "h 미연결 후보",
          ...(this.options.profile !== undefined ? ["Tab 레이어"] : []), ...(this.drift?.count ? ["c 변경 확인"] : []), "s 저장", "q 닫기"].join(" · ")
      case "chain":
        return ["↑↓ 이동", "a 추가", "Enter 교체/추가", "e effort", "d 삭제", "K/J 위·아래로", "b 빌트인 복사", "r 기본값 따르기",
          "x 비활성", "h 미연결 후보", "u 변경 취소", "s 저장", "Esc 목록"].join(" · ")
      case "picker":
        return "글자 입력: 필터 · Backspace 지우기 · ↑↓ 이동 · Enter 선택 · Esc 취소"
      default:
        return "↑↓ 이동 · Enter 선택 · Esc 취소"
    }
  }

  private statusItems(width: number): Item[] {
    const status = this.message
      ?? (this.drafts.size ? { text: `저장 안 된 변경 ${this.drafts.size}건 · s 저장`, tone: "warning" as Tone }
        : this.saved ? { text: `이번에 저장한 변경 ${this.saved}건 · /reload 하면 적용됩니다`, tone: "success" as Tone } : undefined)
    return status ? this.wrapped(status.text, width, TONES[status.tone]).slice(0, 2) : [{ text: "" }]
  }

  private badge(node: EditorNode): string {
    const kind = this.driftOf(node)?.kind
    return kind === "new" ? "NEW" : kind === "changed" ? "변경됨" : kind === "removed" ? "제거됨" : ""
  }

  private listItems(nodes: EditorNode[]): { items: Item[]; focus: number } {
    const nameWidth = Math.min(24, Math.max(4, ...nodes.map(node => displayWidth(node.label))))
    const items: Item[] = []
    let focus = 0
    let section: string | undefined
    nodes.forEach((node, index) => {
      const title = node.section === "model_profiles" ? "main" : node.section
      if (title !== section) {
        section = title
        items.push({ text: title, color: "muted", bold: true, header: true })
      }
      const selected = index === this.cursor
      if (selected) focus = items.length
      const badges = [this.badge(node), this.dirty(node) ? "*" : "", nodeWarnings(node, this.options.availability).length ? "⚠" : ""].filter(Boolean).join(" ")
      const summary = node.readOnly ?? (node.effective.source === "disabled" ? "(비활성)" : this.chainText(node.effective.display, true))
      items.push({
        text: `${selected ? "▸" : " "} ${padCells(node.label, nameWidth)}  ${padCells(nodeState(node, this.layer), 6)}  ${padCells(badges, 8)}  ${summary}`,
        color: selected ? "accent" : node.effective.source === "disabled" ? "dim" : undefined, bold: selected,
      })
    })
    return { items, focus }
  }

  private chainItems(node: EditorNode, mode: ChainMode): { items: Item[]; focus: number } {
    const chain = this.editChain(node)
    mode.cursor = Math.min(mode.cursor, chain.length)
    const own = (this.layer === undefined ? node.base : node.profile)?.chain?.length
    const items: Item[] = [{ text: `${node.label} · ${this.layerLabel()} 편집 · 상태 ${nodeState(node, this.layer)}`, bold: true, header: true }]
    if (!own) items.push({ text: "  아래 레이어/빌트인 체인을 보여 줍니다. 바꾸면 이 레이어의 커스텀 체인이 됩니다 (r: 다시 따르기)", color: "dim", header: true })
    const specWidth = Math.min(40, Math.max(8, ...chain.map(spec => displayWidth(labelSpec(spec)))))
    const first = items.length
    chain.forEach((spec, index) => {
      const view = rungView(spec, this.options.availability)
      const parts = splitSpec(spec)
      const info = parts && this.options.availability.models.get(`${parts.providers[0]}/${parts.model}`)
      const tag = !view.visible ? "미연결" : view.unknown ? "⚠ 연결된 모델 목록에 없음" : info?.name ?? ""
      const selected = index === mode.cursor
      items.push({
        text: `${selected ? "▸" : " "} ${String(index + 1).padStart(2)}. ${padCells(labelSpec(spec), specWidth)}  ${tag}`,
        color: selected ? "accent" : view.visible ? undefined : "dim", bold: selected,
      })
    })
    const onAdd = mode.cursor >= chain.length
    items.push({ text: `${onAdd ? "▸" : " "}  + 모델 추가`, color: onAdd ? "accent" : "muted", bold: onAdd })
    for (const warning of chainWarnings(chain, this.options.availability)) items.push({ text: `⚠ ${warning}`, color: "warning" })
    return { items, focus: first + mode.cursor }
  }

  private pickerItems(mode: PickerMode): { items: Item[]; focus: number } {
    const models = this.pickerModels(mode.filter)
    mode.pick = Math.max(0, Math.min(mode.pick, models.length - 1))
    const total = this.options.availability.models.size
    const items: Item[] = [{
      text: `모델 선택 (${mode.add ? "추가" : `${mode.rung + 1}번 교체`}) · 필터: ${mode.filter}▏ · ${models.length}/${total}`,
      bold: true, header: true,
    }]
    const idWidth = Math.min(44, Math.max(8, ...models.map(model => displayWidth(`${labelProvider(model.provider)}/${model.id}`))))
    models.forEach((model, index) => {
      const selected = index === mode.pick
      items.push({ text: `${selected ? "▸" : " "} ${padCells(`${labelProvider(model.provider)}/${model.id}`, idWidth)}  ${model.name}`, color: selected ? "accent" : undefined, bold: selected })
    })
    if (!models.length) items.push({ text: "  (필터와 맞는 모델 없음)", color: "dim" })
    return { items, focus: models.length ? 1 + mode.pick : 1 }
  }

  private effortItems(mode: EffortMode): { items: Item[]; focus: number } {
    const items: Item[] = [{ text: `effort 선택 · ${labelProvider(mode.provider)}/${mode.model}`, bold: true, header: true }]
    mode.options.forEach((option, index) => {
      const selected = index === mode.pick
      items.push({ text: `${selected ? "▸" : " "} ${option}`, color: selected ? "accent" : undefined, bold: selected })
    })
    return { items, focus: 1 + mode.pick }
  }

  private detailItems(node: EditorNode | undefined, width: number): Item[] {
    if (!node) return []
    const out: Item[] = []
    const add = (text: string, color?: string): void => {
      out.push(...wrapText(text, width, width >= 12 ? "    " : "").map(line => ({ text: line, color })))
    }
    add(`${node.label}: ${node.description}`, "muted")
    if (node.readOnly) {
      add(node.readOnly)
      return out
    }
    const drift = this.driftOf(node)
    const { profile, omo, availability } = this.options
    add(`빌트인${omo ? ` (OMO ${omo})` : ""}: ${node.builtin ? this.chainText(node.builtin.display, true) : node.userOnly ? "없음 (사용자 정의 노드)" : "읽지 못함"}`)
    if (drift?.kind === "changed" && drift.before) add(`이전 빌트인${this.drift?.since ? ` (OMO ${this.drift.since})` : ""}: ${formatChain(drift.before)}`, "dim")
    if (drift?.kind === "new") add("이번 OMO에서 새로 생긴 노드입니다", "warning")
    if (drift?.kind === "removed") add("OMO 빌트인에서 빠졌습니다: 지금은 내 설정만 남아 있습니다", "warning")
    add(`base: ${this.overrideText(node.base, "빌트인을 따름")}`)
    if (profile !== undefined) add(`profile ${profile}: ${this.overrideText(node.profile, node.base?.chain ? "base를 따름" : "빌트인을 따름")}`)
    add(`적용: ${node.effective.source === "disabled" ? "(비활성)" : `${this.chainText(node.effective.display, true)}  [${node.effective.source}]`}`)
    if (drift?.kind === "changed" && (node.base?.chain || node.profile?.chain))
      add("⚠ 빌트인이 바뀌었지만 내 체인이 그 위를 덮고 있습니다: r로 기본값을 따르면 업데이트가 반영됩니다", "warning")
    if (this.layer === undefined && profile !== undefined && node.profile?.chain)
      add(`⚠ profile ${profile}의 체인이 이 노드를 덮습니다: base 변경은 이 프로필 세션에 보이지 않습니다`, "warning")
    for (const warning of nodeWarnings(node, availability)) add(`⚠ ${warning}`, "warning")
    return out
  }

  private height(): number {
    const rows = Math.floor(Number(this.options.rows?.()) || 30)
    return Math.max(1, Math.min(Math.floor(rows * EDITOR_HEIGHT), rows - 2))
  }
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
  /** OMO also merges project configs found from the session's cwd upward. */
  const projectCwd = (ctx: any): string | undefined => deps.cwd ?? (typeof ctx?.cwd === "string" ? ctx.cwd : undefined)
  const projectFound = (ctx: any): ProjectConfig[] => {
    const cwd = projectCwd(ctx)
    return cwd ? projectConfigs(cwd, home) : []
  }
  /** Read-only: the reports compare with the last reviewed snapshot but never write it. */
  const reviewDrift = (builtin: BuiltinRouting): Drift | undefined => {
    const reviewed = readSnapshot(snapshotPath(home))
    if (!reviewed || builtin.status !== "loaded") return undefined
    const drift = snapshotDrift(reviewed, builtinSnapshot(builtin, omoVersion(env)))
    return drift.count ? drift : undefined
  }
  // The last report shown, redrawn after the editor saves.
  let lastView: { wanted: string | undefined; build: (input: ReportInput, width: number) => string[] } | undefined

  const show = (
    ctx: any, raw: any, wanted: string | undefined, extra: string[] = [],
    build: (input: ReportInput, width: number) => string[] = buildReport,
  ) => {
    const profiles = profileNames(raw)
    const { config, profile, warning } = applyProfile(raw, wanted)
    // Read the installed source once; the table itself is laid out per viewport.
    const builtin = loadBuiltinRouting(env)
    const report: ReportInput = {
      config, profile, profiles, warning, builtin, configPath: findConfig(),
      notices: projectFound(ctx).map(found => projectNotice(found)), drift: reviewDrift(builtin),
    }
    lastView = { wanted, build }
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

  /** `/routing edit`: the interactive overlay. Opens on the current (or named)
   * profile's layer with base one Tab away, or on base alone with --base. */
  const editor = async (words: string[], ctx: any) => {
    const parsed = parseModelsArgs(words, "edit")
    if (typeof parsed === "string") { ctx.ui.notify(`routing: ${parsed}`, "error"); return }
    if (typeof ctx?.ui?.custom !== "function" || (ctx.mode !== undefined && ctx.mode !== "tui")) {
      ctx.ui.notify("routing: /routing edit needs the interactive omo TUI; here use /routing set|prepend|add|remove (see /routing help)", "error")
      return
    }
    const cfgPath = findConfig() ?? join(omoDir, "omo.jsonc")
    let openedText = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : undefined
    let raw: any
    try {
      raw = openedText === undefined ? {} : parseJsonc(openedText)
    } catch (error) {
      ctx.ui.notify(`routing: cannot parse ${cfgPath}: ${errorText(error)}`, "error")
      return
    }
    const profiles = profileNames(raw)
    if (parsed.profile && !profiles.includes(parsed.profile)) {
      ctx.ui.notify(`routing: no profile "${parsed.profile}" in omo.jsonc (available profiles: ${profiles.length ? profiles.join(", ") : "none"})`, "error")
      return
    }
    const envProfile = resolveProfileName(env)
    const profile = parsed.base ? undefined : parsed.profile ?? (envProfile !== undefined && profiles.includes(envProfile) ? envProfile : undefined)
    if (profile !== undefined && SKIP_KEYS.has(profile)) {
      ctx.ui.notify(`routing: a profile named "${profile}" cannot be edited here (OMO's config merge skips that key); use --base or rename it`, "error")
      return
    }
    const warnings: string[] = []
    if (!parsed.base && !parsed.profile && envProfile !== undefined && !profiles.includes(envProfile))
      warnings.push(`환경이 가리키는 프로필 "${envProfile}"이 omo.jsonc에 없어 base만 편집합니다`)
    const builtin = loadBuiltinRouting(env)
    if (builtin.status !== "loaded") warnings.push(`OMO 빌트인 기본값을 읽지 못해 설정된 체인만 보입니다 (${builtin.reason})`)
    else for (const [section, reason] of Object.entries(builtin.defaults.unavailable))
      warnings.push(`빌트인 ${SECTION_LABELS[section as BuiltinSection]}을 읽지 못해 그 노드는 설정된 체인만 보입니다 (${reason})`)
    for (const found of projectFound(ctx)) warnings.push(projectNotice(found, true))
    const omo = omoVersion(env)
    const snapshotFile = snapshotPath(home)
    const current = builtinSnapshot(builtin, omo)
    let reviewed = readSnapshot(snapshotFile)
    // Whatever the snapshot does not cover yet is recorded as reviewed now, so
    // only later OMO updates count as changes: everything on the first open, a
    // section that could not be read when the snapshot was taken.
    const unrecorded = SECTIONS.filter(section => current.sections[section] && !reviewed?.sections[section])
    if (unrecorded.length) {
      const recorded: Snapshot = reviewed
        ? { ...reviewed, sections: { ...reviewed.sections, ...Object.fromEntries(unrecorded.map(section => [section, current.sections[section]])) } }
        : current
      try {
        writeSnapshot(snapshotFile, recorded)
        reviewed = recorded
      } catch (error) {
        warnings.push(`빌트인 스냅샷을 쓰지 못해 변경 추적이 꺼집니다: ${errorText(error)}`)
      }
    }
    const levels = await hostThinkingLevels(env)
    const availability = availabilityOf(ctx.modelRegistry)
    let backedUp = false
    const result = await ctx.ui.custom((tui: any, theme: any, keybindings: any, done: (result: { saved: number }) => void) => new RoutingEditor({
      raw, builtin, availability, profile, omo, warnings, configPath: cfgPath,
      drift: reviewed ? snapshotDrift(reviewed, current) : undefined,
      levels: model => effortLevels(model, levels),
      save: (drafts, confirmExternal) => {
        // .bak keeps the file as it was before this session's first save.
        const saved = saveConfig({ path: cfgPath, openedText, drafts, confirmExternal, backup: !backedUp })
        if (saved.status === "saved") {
          openedText = saved.text
          backedUp ||= saved.backup !== undefined
        }
        return saved
      },
      markReviewed: () => {
        reviewed = mergeSnapshot(reviewed, current)
        writeSnapshot(snapshotFile, reviewed)
        return snapshotDrift(reviewed, current)
      },
      done,
      rows: () => tui?.terminal?.rows ?? 30,
      requestRender: () => tui?.requestRender?.(),
    }, theme, keybindings), { overlay: true, overlayOptions: { ...EDITOR_OVERLAY } })
    const saved = typeof result?.saved === "number" ? result.saved : 0
    if (!saved) return
    const backup = existsSync(`${cfgPath}.bak`) ? ` (previous version: ${cfgPath}.bak)` : ""
    ctx.ui.notify(`routing: saved ${saved} change(s) to ${cfgPath}${backup}; /reload to apply`, "info")
    if (shown && lastView) {
      const text = findConfig()
      show(ctx, text ? parseJsonc(readFileSync(text, "utf8")) : {}, lastView.wanted, [], lastView.build)
    }
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
    description: "show effective model chains (config + installed OMO defaults), or edit config (`edit` opens an interactive editor); `help` lists the forms",
    argumentHint: "[profile|base|off|help|models|edit|set|prepend|add|remove ...]",
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
      if (words[0] === "edit") { await editor(words.slice(1), ctx); return }
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
