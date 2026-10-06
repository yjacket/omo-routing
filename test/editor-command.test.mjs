// `/routing edit` through the registered command: the fake ctx supplies
// ui.custom, a model registry and an installed-OMO fixture. No senpi, no LLM.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { applyProfile, createRouting, parseJsonc, resolveProfileName } from "../extension/routing.ts"
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

/** `host` picks how the fake ctx.reload behaves: "ok" runs the real lifecycle (before_reload
 * veto check, session_shutdown, then the new session resolving OMO_PROFILE from the live env
 * against the parsed file); "streaming" resolves void without doing anything; "veto" is
 * another extension vetoing; "throw" fails before the lifecycle starts, "late-throw" after
 * session_shutdown; "none" is a host without ctx.reload. After a successful reload the old
 * runner is stale: using its ctx throws. */
function setup(t, { config = CONFIG, mode = "tui", custom = true, cwd, env: extraEnv = {}, host: hostMode } = {}) {
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
  let closeHook
  let idleHook
  const notes = []
  const env = { OMO_BIN: join(root, "bin", "omo.js"), ...extraEnv }
  const host = { stale: false, opens: 0, order: [], idleEnv: [], vetoes: [], reloads: [] }
  const live = () => { if (host.stale) throw new Error("the old extension runner was used after a successful reload") }
  const events = {}
  const ctx = {
    mode, cwd: typeof cwd === "function" ? cwd(home) : cwd,
    modelRegistry: { getAvailable: () => MODELS },
    ui: {
      notify: (message, kind) => { live(); notes.push({ message, kind }) },
      ...(custom ? {
        custom: (factory, options) => new Promise(done => {
          live()
          host.opens++
          const editor = factory({ terminal: { rows: 50 }, requestRender() {} }, undefined, undefined, result => { closeHook?.(result); done(result) })
          resolveOpen?.({ editor, options })
        }),
      } : {}),
    },
    ...(hostMode === undefined || hostMode === "none" ? {} : {
      waitForIdle: async () => { live(); host.order.push("idle"); host.idleEnv.push(env.OMO_PROFILE); await idleHook?.() },
      reload: async () => {
        live()
        host.order.push("reload")
        if (hostMode === "streaming") return
        if (hostMode === "throw") throw new Error("reload exploded")
        const veto = await events.session_before_reload?.({ type: "session_before_reload" }, ctx)
        host.vetoes.push(veto)
        if (veto?.cancel || hostMode === "veto") return
        await events.session_shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx)
        host.stale = true
        if (hostMode === "late-throw") throw new Error("boom after shutdown")
        const name = resolveProfileName(env)
        host.reloads.push({ name, ...applyProfile(parseJsonc(readFileSync(cfgPath, "utf8")), name) })
      },
    }),
  }
  createRouting({ registerCommand: (_name, def) => { command = def }, on: (name, fn) => { events[name] = fn } }, { home, env })
  return {
    home, cfgPath, notes, env, host,
    /** Run `fn` with the editor's result at the moment it closes, before the command continues. */
    beforeClose: fn => { closeHook = fn },
    duringIdle: fn => { idleHook = fn },
    /** Resolves with the overlay of the next `ui.custom` call (arm it before the key that closes the current one). */
    next: () => new Promise(resolve => { resolveOpen = resolve }),
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

const nameProfile = (editor, name) => press(editor, "p", KEY.enter, ...name, KEY.enter)
const withoutProfile = (raw, name) => {
  const copy = structuredClone(raw)
  delete copy.profiles[name]
  return copy
}

test("saving the current routing as a new profile writes only that profile; drafts stay pending and save later to their own layer", async t => {
  const h = setup(t)
  const { editor, finished } = await h.open("-p work")
  select(editor, "deep")
  press(editor, "x")
  assert.equal(editor.pending().length, 1)
  nameProfile(editor, "freeze")
  const first = readFileSync(h.cfgPath, "utf8")
  assert.match(first, /\/\/ my routing/)
  const saved = parseJsonc(first)
  assert.deepEqual(saved.profiles.freeze, { "[native]": {
    model_profile: "capable",
    categories: { deep: { models: ["anthropic-subscription/claude-opus:high"], disable: true } },
  } })
  assert.deepEqual(withoutProfile(saved, "freeze"), parseJsonc(CONFIG), "base and the source profile are untouched; the draft is not written")
  assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), CONFIG)
  assert.equal(editor.pending().length, 1, "the staged draft is still pending")
  assert.match(screen(editor), /프로필 "freeze" 저장 완료/)
  // The draft saves to its own layer afterwards; the profile and the pre-session .bak stay.
  press(editor, KEY.esc, "s")
  const later = parseJsonc(readFileSync(h.cfgPath, "utf8"))
  assert.deepEqual(later.profiles.work["[native]"].categories.deep, { disable: true })
  assert.deepEqual(later.profiles.freeze, saved.profiles.freeze)
  assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), CONFIG, "one pre-session backup")
  press(editor, "q")
  await finished
  assert.match(h.notes.at(-2).message, /^routing: saved new profile\(s\) freeze to .*omo\.jsonc \(previous version: /)
  assert.match(h.notes.at(-1).message, /^routing: saved 1 change\(s\) to /, "the draft count is not inflated by the profile")
})

test("a profile save after an outside edit needs a second Enter and is revalidated against the file itself", async t => {
  const h = setup(t)
  const { editor, finished } = await h.open("--base")
  const outside = CONFIG.replace("// my routing", "// edited elsewhere")
  writeFileSync(h.cfgPath, outside)
  nameProfile(editor, "snap")
  assert.match(screen(editor), /편집기를 연 뒤 바뀌었습니다/)
  assert.equal(readFileSync(h.cfgPath, "utf8"), outside, "cancel or wait: nothing written")
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
  // Someone creates the same name before the confirmation.
  const taken = outside.replace('"work":', '"snap": {}, "work":')
  writeFileSync(h.cfgPath, taken)
  press(editor, KEY.enter)
  assert.match(screen(editor), /프로필 "snap"이 이미 있습니다/)
  assert.equal(readFileSync(h.cfgPath, "utf8"), taken, "an existing profile is never overwritten")
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
  writeFileSync(h.cfgPath, outside)
  press(editor, KEY.enter)
  press(editor, KEY.enter)
  assert.ok(parseJsonc(readFileSync(h.cfgPath, "utf8")).profiles.snap)
  assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), outside)
  press(editor, KEY.esc, "q")
  await finished
})

test("a missing omo.jsonc gets an empty profile (empty routing is valid); a pending base removal is refused, nothing written", async t => {
  const none = setup(t, { config: null })
  const a = await none.open("--base")
  nameProfile(a.editor, "first")
  assert.deepEqual(parseJsonc(readFileSync(none.cfgPath, "utf8")), { profiles: { first: { "[native]": {} } } })
  assert.ok(!existsSync(`${none.cfgPath}.bak`))
  press(a.editor, KEY.esc, "q")
  await a.finished

  const h = setup(t)
  const { editor, finished } = await h.open("--base")
  select(editor, "deep")
  press(editor, "r")
  assert.equal(editor.pending().length, 1)
  nameProfile(editor, "gone")
  assert.match(screen(editor), /프로필로 표현할 수 없습니다 \(categories\.deep\)/)
  assert.equal(readFileSync(h.cfgPath, "utf8"), CONFIG)
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
  press(editor, KEY.esc, KEY.esc, "q", "q")
  await finished
  assert.equal(h.notes.length, 0, "no profile was saved, so no notice")
})

test("a malformed profiles container is refused without touching the file", async t => {
  const h = setup(t, { config: `{ "profiles": [] }\n` })
  const { editor, finished } = await h.open("--base")
  nameProfile(editor, "x")
  assert.match(screen(editor), /profiles가 객체가 아니라 프로필을 추가할 수 없습니다/)
  assert.equal(readFileSync(h.cfgPath, "utf8"), `{ "profiles": [] }\n`)
  press(editor, KEY.esc, KEY.esc, "q")
  await finished
})

test("pasting a changed profile name cancels the external-write confirmation", async t => {
  const h = setup(t)
  const { editor, finished } = await h.open("--base")
  const outside = CONFIG.replace("// my routing", "// concurrent edit")
  writeFileSync(h.cfgPath, outside)
  nameProfile(editor, "snap")
  editor.handleInput("\x1b[200~two\x1b[201~")
  press(editor, KEY.enter)
  assert.equal(readFileSync(h.cfgPath, "utf8"), outside, "the changed name needs its own second Enter")
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
  press(editor, KEY.enter)
  assert.ok(parseJsonc(readFileSync(h.cfgPath, "utf8")).profiles.snaptwo)
  press(editor, KEY.esc, "q")
  await finished
})

// Applying a saved profile: p, the profile, then the confirmation (Enter on "적용"; with staged
// edits the default row is "취소", so "버리고 적용" is Down + Enter).
const APPLY_CONFIG = `{
  // my routing
  "[native]": { "categories": { "deep": { "models": ["anthropic-subscription/claude-opus:high"] } } },
  "profiles": {
    "work": { "[native]": { "model_profile": "capable" } },
    "play": { "[native]": { "categories": { "quick": { "models": ["anthropic-subscription/claude-haiku"] } } } }
  }
}
`
const withoutPlay = text => text.replace(/,\n    "play": .*\n/, "\n")
/** Open the profile menu and press Enter on profile row `row` (1 = first profile): the confirmation shows. */
const choose = (editor, row) => press(editor, "p", ...Array(row).fill(KEY.down), KEY.enter)
const PLAY_QUICK = { models: ["anthropic-subscription/claude-haiku"] }
// A regression that never reopens or never closes the overlay must fail, not hang the run.
const BOUND = { timeout: 20_000 }

test("confirming a profile closes the editor, points OMO_PROFILE at it and reloads; the host resolves exactly that profile", BOUND, async t => {
  const h = setup(t, { config: APPLY_CONFIG, host: "ok", env: { OMO_PROFILE: "work" } })
  const { editor, finished } = await h.open("")
  choose(editor, 2)
  const menu = screen(editor)
  assert.match(menu, /^프로필 "play" 적용$/m)
  assert.match(menu, /현재: work → play/)
  assert.deepEqual(h.host.order, [], "choosing alone asks nothing of the host")
  press(editor, KEY.enter)
  await finished
  assert.deepEqual(h.host.order, ["idle", "reload"])
  assert.deepEqual(h.host.idleEnv, ["work"], "the environment moves only once the host is idle")
  assert.deepEqual(h.host.vetoes, [undefined], "the editor is closed, so its own reload veto is off")
  assert.equal(h.host.reloads.length, 1)
  assert.equal(h.host.reloads[0].profile, "play")
  assert.deepEqual(h.host.reloads[0].config.categories.quick, PLAY_QUICK)
  assert.equal(h.host.reloads[0].config.model_profile, undefined, "not the work profile")
  assert.equal(h.env.OMO_PROFILE, "play")
  assert.equal(readFileSync(h.cfgPath, "utf8"), APPLY_CONFIG, "applying writes nothing")
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
  assert.equal(h.host.opens, 1, "the stale runner opened nothing else")
  assert.equal(h.notes.length, 0, "and said nothing on the replaced session")
  assert.equal(await h.fire("session_before_reload"), undefined)
})

test("cancelling keeps overlay, drafts, file and environment; discarding staged edits to apply is an explicit choice", BOUND, async t => {
  const h = setup(t, { config: APPLY_CONFIG, host: "ok", env: { OMO_PROFILE: "work" } })
  const { editor, finished } = await h.open("")
  select(editor, "deep")
  press(editor, "x")
  const staged = structuredClone(editor.pending())
  choose(editor, 2)
  const text = screen(editor)
  assert.match(text, /^▸ 취소 \(편집 유지\)$/m)
  assert.match(text, /^  저장 안 된 변경 1건 버리고 적용$/m)
  press(editor, KEY.enter)
  assert.deepEqual(h.host.order, [])
  assert.equal(h.env.OMO_PROFILE, "work")
  assert.deepEqual(editor.pending(), staged)
  assert.equal(readFileSync(h.cfgPath, "utf8"), APPLY_CONFIG)
  assert.equal(h.host.opens, 1, "the overlay stayed open")
  press(editor, KEY.enter, KEY.down, KEY.enter)
  await finished
  assert.equal(h.host.reloads[0].profile, "play")
  assert.equal(h.env.OMO_PROFILE, "play")
  assert.equal(readFileSync(h.cfgPath, "utf8"), APPLY_CONFIG, "the discarded edit was never written")
  assert.ok(!existsSync(`${h.cfgPath}.bak`))
})

for (const hostMode of ["streaming", "veto", "throw"]) {
  for (const initial of [undefined, "work"]) {
    test(`a refused apply (${hostMode}, OMO_PROFILE ${initial ?? "unset"}) restores the environment and returns edits, counters and the first .bak`, BOUND, async t => {
      const h = setup(t, { config: APPLY_CONFIG, host: hostMode, env: initial === undefined ? {} : { OMO_PROFILE: initial } })
      const { editor, finished } = await h.open("--base")
      select(editor, "deep")
      press(editor, "x", "s") // an ordinary save: counted, and the first .bak
      nameProfile(editor, "copy") // a new profile: counted separately
      press(editor, KEY.esc)
      select(editor, "quick")
      press(editor, "x")
      const staged = structuredClone(editor.pending())
      assert.equal(staged.length, 1)
      const next = h.next()
      choose(editor, 2)
      press(editor, KEY.down, KEY.enter)
      const again = await next
      assert.equal(Object.hasOwn(h.env, "OMO_PROFILE"), initial !== undefined, "the property is as absent or present as before")
      assert.equal(h.env.OMO_PROFILE, initial)
      assert.notEqual(again.editor, editor)
      assert.deepEqual(again.editor.pending(), staged)
      assert.match(screen(again.editor), hostMode === "throw" ? /프로필 play 적용 안 됨: 다시 불러오지 못했습니다: reload exploded/ : /프로필 play 적용 안 됨: 호스트가 다시 불러오기를 하지 않았습니다/)
      assert.deepEqual(h.host.reloads, [], "calling reload is not a reload")
      assert.deepEqual(h.host.order, ["idle", "reload"])
      assert.deepEqual(h.host.idleEnv, [initial])
      assert.deepEqual(h.host.vetoes, hostMode === "veto" ? [undefined] : [])
      // The restored editor saves its staged edit against the same baseline.
      press(again.editor, "s", "q")
      await finished
      assert.match(h.notes.at(-2).message, /^routing: saved new profile\(s\) copy to /)
      assert.match(h.notes.at(-1).message, /^routing: saved 2 change\(s\) to .*\(previous version: .*omo\.jsonc\.bak\)/)
      assert.equal(readFileSync(`${h.cfgPath}.bak`, "utf8"), APPLY_CONFIG, "still the file from before the session's first save")
      const saved = parseJsonc(readFileSync(h.cfgPath, "utf8"))
      assert.equal(saved["[native]"].categories.quick.disable, true)
      assert.ok(saved.profiles.copy)
    })
  }
}

test("a profile that is gone, unreadable or not an object is refused at confirmation, keeping the overlay and edits", async t => {
  const cases = {
    deleted: [withoutPlay(APPLY_CONFIG), /프로필 "play"이 omo\.jsonc에 없거나 객체가 아닙니다/],
    malformed: ['{ "profiles": ', /omo\.jsonc를 읽지 못했습니다/],
    scalar: [APPLY_CONFIG.replace(/"play": .*\n/, '"play": 5\n'), /없거나 객체가 아닙니다/],
    container: ['{ "profiles": [] }\n', /없거나 객체가 아닙니다/],
  }
  for (const [label, [disk, message]] of Object.entries(cases)) {
    const h = setup(t, { config: APPLY_CONFIG, host: "ok", env: { OMO_PROFILE: "work" } })
    const { editor, finished } = await h.open("")
    select(editor, "deep")
    press(editor, "x")
    const staged = structuredClone(editor.pending())
    choose(editor, 2)
    writeFileSync(h.cfgPath, disk) // changes between choosing and confirming
    press(editor, KEY.down, KEY.enter)
    assert.match(screen(editor), message, label)
    assert.deepEqual(h.host.order, [], label)
    assert.equal(h.env.OMO_PROFILE, "work", label)
    assert.deepEqual(editor.pending(), staged, label)
    assert.equal(readFileSync(h.cfgPath, "utf8"), disk, `${label}: the file is not touched`)
    assert.equal(h.host.opens, 1, `${label}: the same overlay is still open`)
    press(editor, KEY.esc, "q", "q")
    await finished
    assert.equal(h.notes.length, 0, label)
  }
})

test("a reserved profile key is refused at confirmation without moving the environment", async t => {
  const h = setup(t, { config: `{ "profiles": { "constructor": { "[native]": {} }, "work": { "[native]": {} } } }\n`, host: "ok" })
  const { editor, finished } = await h.open("--base")
  choose(editor, 1)
  assert.match(screen(editor), /^프로필 "constructor" 적용$/m)
  press(editor, KEY.enter)
  assert.match(screen(editor), /"constructor"은 프로필 이름으로 쓸 수 없어 적용하지 않습니다/)
  assert.deepEqual(h.host.order, [])
  assert.ok(!Object.hasOwn(h.env, "OMO_PROFILE"))
  press(editor, KEY.esc, "q")
  await finished
})

test("a profile deleted while the overlay closes is caught before the environment moves; the editor returns with its edits", BOUND, async t => {
  const h = setup(t, { config: APPLY_CONFIG, host: "ok", env: { OMO_PROFILE: "work" } })
  const { editor, finished } = await h.open("")
  select(editor, "deep")
  press(editor, "x")
  const staged = structuredClone(editor.pending())
  h.beforeClose(result => { if (result.apply) writeFileSync(h.cfgPath, withoutPlay(APPLY_CONFIG)) })
  const next = h.next()
  choose(editor, 2)
  press(editor, KEY.down, KEY.enter)
  const again = await next
  assert.match(screen(again.editor), /프로필 play 적용 안 됨: 프로필 "play"이 omo\.jsonc에 없거나/)
  assert.deepEqual(again.editor.pending(), staged)
  assert.deepEqual(h.host.order, [], "the host was never asked")
  assert.equal(h.env.OMO_PROFILE, "work")
  press(again.editor, "q", "q")
  await finished
})

test("a host without ctx.reload is reported accurately and nothing is lost", async t => {
  const h = setup(t, { config: APPLY_CONFIG, host: "none" })
  const { editor, finished } = await h.open("--base")
  select(editor, "deep")
  press(editor, "x")
  const staged = structuredClone(editor.pending())
  choose(editor, 2)
  press(editor, KEY.down, KEY.enter)
  assert.match(screen(editor), /다시 불러오기\(reload\) API가 없어 적용할 수 없습니다/)
  assert.deepEqual(editor.pending(), staged)
  assert.ok(!Object.hasOwn(h.env, "OMO_PROFILE"))
  assert.equal(h.host.opens, 1)
  press(editor, KEY.esc, "q", "q")
  await finished
})

test("a reload that fails after the old session was torn down is not undone: the error surfaces and the environment keeps the profile", BOUND, async t => {
  const h = setup(t, { config: APPLY_CONFIG, host: "late-throw", env: { OMO_PROFILE: "work" } })
  const { editor, finished } = await h.open("")
  choose(editor, 2)
  press(editor, KEY.enter)
  await assert.rejects(finished, /boom after shutdown/)
  assert.equal(h.env.OMO_PROFILE, "play")
  assert.equal(h.host.opens, 1)
})

test("a profile removed while waiting for idle is rechecked, with unrelated reloads held until the handoff", BOUND, async t => {
  const h = setup(t, { config: APPLY_CONFIG, host: "ok", env: { OMO_PROFILE: "work" } })
  const { editor, finished } = await h.open("")
  select(editor, "deep")
  press(editor, "x")
  const staged = structuredClone(editor.pending())
  let waitingVeto
  h.duringIdle(async () => {
    waitingVeto = await h.fire("session_before_reload")
    writeFileSync(h.cfgPath, withoutPlay(APPLY_CONFIG))
  })
  const next = h.next().then(opened => ({ kind: "reopened", ...opened }))
  choose(editor, 2)
  press(editor, KEY.down, KEY.enter)
  const outcome = await Promise.race([next, finished.then(() => ({ kind: "applied" }))])
  assert.equal(outcome.kind, "reopened", "a target removed during idle must never silently select base")
  assert.equal(waitingVeto?.cancel, true, "automatic reload cannot retire the waiting command's runtime")
  assert.equal(h.env.OMO_PROFILE, "work")
  assert.deepEqual(h.host.order, ["idle"])
  assert.deepEqual(outcome.editor.pending(), staged)
  press(outcome.editor, "q", "q")
  await finished
})
