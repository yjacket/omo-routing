// routing: print the configured model routing from ~/.omo/omo.jsonc — the
// per-category and per-agent chains — for the current profile, or for a
// profile named on the command line.
//
//   /routing            current profile (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR tail; else base)
//   /routing <profile>  `profiles.<name>` applied on top of the base config
//   /routing base       base config only, no profile overlay
//   /routing off        hide the widget (a bare /routing also toggles it off)
//
//   /routing help       usage for every form
//   /routing set    <name> <model...>   replace the chain (full fallback order)
//   /routing add    <name> <model...>   append rungs
//   /routing remove <name> <model...>   drop rungs
//     <name>:   main | main:<model_profile> | <category> | <agent> | category:<n> | agent:<n>
//     <model>:  provider/model[:variant]
//     --profile <name> / --base pick the layer written; default is the current
//     profile's `[senpi]` section (base when no profile is set).
//
// Resolution mirrors omo-task.js: layers merge base -> [senpi] -> profile base
// -> profile [senpi]; objects deep-merge, arrays replace. Edits are applied to
// the omo.jsonc text at byte offsets, so comments and formatting survive; a
// copy of the previous file is kept as omo.jsonc.bak. Nothing is checked
// against live provider state.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, userInfo } from "node:os"

export type Deps = { env?: Record<string, string | undefined>; home?: string }

const SKIP_KEYS = new Set(["__proto__", "constructor", "prototype"])
const HARNESS_KEYS = new Set(["[opencode]", "[senpi]", "[codex]"])

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
const harnessSection = (cfg: any, harness: string): any => (isObj(cfg?.[`[${harness}]`]) ? cfg[`[${harness}]`] : {})

export function profileNames(raw: any): string[] {
  return isObj(raw?.profiles) ? Object.keys(raw.profiles) : []
}

/**
 * Effective config for the senpi harness: base -> [senpi] -> profile base ->
 * profile [senpi]. `profile` is the name actually applied (undefined for base
 * or when the named profile does not exist, in which case `warning` is set).
 */
export function applyProfile(raw: any, profile: string | undefined, harness = "senpi"): { config: any; profile?: string; warning?: string } {
  const profiles = isObj(raw?.profiles) ? raw.profiles : {}
  const overlay = profile && isObj(profiles[profile]) ? profiles[profile] : undefined
  const warning = profile && !overlay ? `profile "${profile}" does not exist; showing the base configuration` : undefined
  let merged: any = {}
  for (const layer of [withoutSpecial(raw), harnessSection(raw, harness), withoutSpecial(overlay), harnessSection(overlay, harness)])
    merged = mergeConfig(merged, layer)
  return { config: withoutSpecial(merged), profile: overlay ? profile : undefined, warning }
}

/** Chain of an agent/category/model_profile entry as "provider/model:variant" strings. */
export function chainOf(entry: any): string[] {
  if (!isObj(entry)) return []
  const specs = [...(entry.model !== undefined ? [entry.model] : []), ...(Array.isArray(entry.models) ? entry.models : [])]
  return specs
    .map((s) => (isObj(s) && typeof s.model === "string" ? s.model + (s.variant ? `:${s.variant}` : "") : s))
    .filter((s): s is string => typeof s === "string" && s.length > 0)
}

/** One row per entry: `name  a -> b -> c`, name padded to `width`. */
export function formatRow(name: string, chain: string[], width = name.length): string {
  return `${name.padEnd(width)}  ${chain.length ? chain.join(" -> ") : "(no chain configured)"}`
}

/**
 * Fit report lines to a viewport width: a row wider than `width` is wrapped at
 * " -> " boundaries, continuation lines indented to the chain column.
 */
export function fitLines(lines: string[], width: number): string[] {
  if (!(width > 0)) return lines
  const out: string[] = []
  for (const line of lines) {
    if (line.length <= width) { out.push(line); continue }
    const m = line.match(/^(\S+(?: \(\S+\))?\s{2,})(.*)$/)
    const indent = m ? " ".repeat(m[1].length) : "  "
    const parts = (m ? m[2] : line).split(" -> ")
    let cur = m ? m[1] : ""
    for (const [i, part] of parts.entries()) {
      const piece = i === parts.length - 1 ? part : part + " ->"
      const sep = cur.trim().length && !cur.endsWith("  ") ? " " : ""
      if (cur.length + sep.length + piece.length > width && cur.trim().length) { out.push(cur.trimEnd()); cur = indent + piece }
      else cur += sep + piece
    }
    out.push(cur.trimEnd())
  }
  return out
}

/** pi-tui component factory: bypasses the host's fixed line cap for string-array widgets. */
export function widgetFactory(lines: string[]) {
  return (_tui: unknown, _theme: unknown) => ({ render: (width: number) => fitLines(lines, width), invalidate() {} })
}

export function buildReport(input: {
  config: any
  profile?: string
  profiles: string[]
  warning?: string
}): string[] {
  const { config, profile, profiles, warning } = input
  const lines: string[] = []
  lines.push(`profile: ${profile ?? "(base)"}   model_profile: ${config?.model_profile ?? "(none)"}   available: ${profiles.length ? profiles.join(", ") : "(none)"}`)
  if (warning) lines.push(`warning: ${warning}`)
  const mp = config?.model_profile
  const mpChain = chainOf(config?.model_profiles?.[mp])
  const categories = isObj(config?.categories) ? config.categories : {}
  const agents = isObj(config?.agents) ? config.agents : {}
  const mainName = mp && mpChain.length ? `main (${mp})` : undefined
  const width = Math.max(0, ...[mainName ?? "", ...Object.keys(categories), ...Object.keys(agents)].map((n) => n.length))
  if (mainName) lines.push("", formatRow(mainName, mpChain, width))
  if (Object.keys(categories).length) {
    lines.push("", "categories:")
    for (const name of Object.keys(categories).sort()) lines.push(formatRow(name, chainOf(categories[name]), width))
  }
  if (Object.keys(agents).length) {
    lines.push("", "agents:")
    for (const name of Object.keys(agents).sort()) lines.push(formatRow(name, chainOf(agents[name]), width))
  }
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

const EDIT_VERBS = new Set(["set", "add", "remove"])

/** `/routing help` text; also the pointer given on a malformed edit. */
export const HELP_LINES = [
  "/routing                      current profile's chains (again or `off` hides)",
  "/routing <profile> | base     a named profile's chains | base config only",
  "/routing help                 this text",
  "",
  "/routing set    <name> <model...>   replace the chain with these rungs, in fallback order",
  "/routing add    <name> <model...>   append rungs",
  "/routing remove <name> <model...>   drop rungs",
  "",
  "  <name>   main | main:<model_profile> | <category> | <agent> | category:<n> | agent:<n>",
  "  <model>  provider/model[:variant], e.g. openai-codex/gpt-5.6-sol:high",
  "  --profile <p> | --base   layer to write (default: current profile, else base)",
  "",
  "Edits touch only that `models` array in ~/.omo/omo.jsonc; the previous file is kept as omo.jsonc.bak.",
]

export type EditArgs = { verb: "set" | "add" | "remove"; target: string; models: string[]; profile?: string; base: boolean }

/** Parse `set|add|remove [--profile <name>|--base] <target> <model...>`; returns an error string on bad input. */
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
  if (!target) return `usage: /routing ${verb} [--profile <name>|--base] <name> <provider/model[:variant]...> (see /routing help)`
  if (!models.length) return `no models given for "${target}" (provider/model[:variant], space separated; see /routing help)`
  const bad = models.find((m) => !/^[^\s/:]+\/[^\s/]+$/.test(m))
  if (bad) return `"${bad}" is not provider/model[:variant] (see /routing help)`
  return { verb, target, models, profile, base }
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

/** New chain after applying the verb to the current chain. */
export function applyChainEdit(verb: EditArgs["verb"], current: string[], models: string[]): string[] {
  if (verb === "set") return [...new Set(models)]
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

  const show = (ctx: any, raw: any, wanted: string | undefined, extra: string[] = []) => {
    const profiles = profileNames(raw)
    const { config, profile, warning } = applyProfile(raw, wanted)
    const lines = [...extra, ...buildReport({ config, profile, profiles, warning })]
    // Widget hosts get the table above the editor and nothing else;
    // hosts without a widget get the whole report in the toast.
    if (typeof ctx?.ui?.setWidget === "function") {
      ctx.ui.setWidget("routing", widgetFactory([...lines, "", "(/routing again or /routing off to hide)"]), { placement: "aboveEditor" })
      shown = true
    } else {
      ctx.ui.notify(lines.join("\n"), "info")
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
      ctx.ui.notify(`routing: no profile "${profile}" in omo.jsonc (available: ${profiles.length ? profiles.join(", ") : "none"}); use --base to edit the base config`, "error")
      return
    }
    const { config } = applyProfile(raw, profile)
    const target = resolveTarget(parsed.target, config)
    if (typeof target === "string") { ctx.ui.notify(`routing: ${target}`, "error"); return }

    // Layer written: the profile's (or base's) `[senpi]` section when it exists
    // or nothing else is there; otherwise the layer root.
    const layerPath = profile ? ["profiles", profile] : []
    const layer = profile ? raw.profiles[profile] : raw
    const useSenpi = isObj(layer?.["[senpi]"]) || !["categories", "agents", "model_profiles"].some((k) => isObj(layer?.[k]))
    const entryPath = [...layerPath, ...(useSenpi ? ["[senpi]"] : []), ...target.path]

    const chain = applyChainEdit(parsed.verb, chainOf(config?.[target.path[0]]?.[target.path[1]]), parsed.models)
    let next = removeJsoncPath(src, [...entryPath, "model"])
    next = setJsoncPath(next, [...entryPath, "models"], chain)
    try { parseJsonc(next) } catch (e: any) { ctx.ui.notify(`routing: refusing to write, result is not valid JSON: ${e?.message ?? e}`, "error"); return }
    copyFileSync(cfgPath, cfgPath + ".bak")
    writeFileSync(cfgPath, next, "utf8")
    const where = `${profile ? `profile ${profile}` : "base"}${useSenpi ? " [senpi]" : ""}`
    show(ctx, parseJsonc(next), profile, [`wrote ${target.label} in ${where}: ${chain.length ? chain.join(" -> ") : "(no chain configured)"}`, ""])
  }

  pi.registerCommand("routing", {
    description: "show or edit the model chains configured in omo.jsonc; `help` lists the forms",
    argumentHint: "[profile|base|off|help|set|add|remove ...]",
    handler: async (args: string, ctx: any) => {
      const hasWidget = typeof ctx?.ui?.setWidget === "function"
      const arg = (args ?? "").trim()
      if (hasWidget && (arg === "off" || (arg === "" && shown))) { hide(ctx); return }
      if (arg === "help" || arg === "-h" || arg === "--help") {
        if (hasWidget) { ctx.ui.setWidget("routing", widgetFactory([...HELP_LINES, "", "(/routing again or /routing off to hide)"]), { placement: "aboveEditor" }); shown = true }
        else ctx.ui.notify(HELP_LINES.join("\n"), "info")
        return
      }
      if (EDIT_VERBS.has(arg.split(/\s+/)[0])) { edit(arg, ctx); return }
      const cfgPath = findConfig()
      const raw = cfgPath ? parseJsonc(readFileSync(cfgPath, "utf8")) : {}
      const profiles = profileNames(raw)
      const wanted = arg === "" ? resolveProfileName(env) : arg === "base" ? undefined : arg
      if (arg && arg !== "base" && !profiles.includes(arg)) {
        ctx.ui.notify(`routing: no profile "${arg}" in omo.jsonc (available: ${profiles.length ? profiles.join(", ") : "none"})`, "error")
        return
      }
      show(ctx, raw, wanted)
    },
  })
}

export default function (pi: any): void {
  createRouting(pi)
}
