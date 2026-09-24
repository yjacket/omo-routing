// The /routing edit overlay driven by key presses, as pi-tui delivers them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { availabilityOf, decodeKey } from "../extension/routing.ts"
import { KEY, cells, makeEditor, press, screen, select, strip } from "./editor-fixture.mjs"

const row = (text, label) => text.split("\n").find(line => line.startsWith(`▸ ${label} `) || line.startsWith(`  ${label} `))

test("the list shows every node with its state; unconnected rungs are hidden with a count and narrowed groups", () => {
  const { editor } = makeEditor({ profile: "work" })
  const text = screen(editor)
  assert.match(text, /^라우팅 편집 · OMO 1\.2\.3 · 편집 레이어: profile work \[native\] \(Tab 전환\)/)
  assert.match(text, /연결된 프로바이더: claude, codex, devin · 미연결 후보 숨김 \(h\)/)
  for (const label of ["main (capable)", "deep", "implementer", "quick", "writing", "explore", "reviewer"]) assert.ok(row(text, label), label)
  assert.match(row(text, "deep"), /deep\s+-\s+base\s+claude\/claude-opus:H$/)
  assert.match(row(text, "quick"), /quick\s+Fast small work…\s+비활성\s+\(비활성\)$/)
  assert.match(row(text, "writing"), /writing\s+-\s+빌트인\s+claude\/claude-fable:L$/)
  const base = makeEditor()
  select(base.editor, "quick")
  const quick = screen(base.editor)
  assert.match(row(quick, "quick"), /codex\/gpt-mini:L → claude\/claude-haiku:O$/, "a group shows only its connected provider")
  assert.match(quick, /^설명|^quick: Fast small work…/m)
  select(base.editor, "reviewer")
  const reviewer = screen(base.editor)
  assert.match(reviewer, /빌트인 \(OMO 1\.2\.3\): codex\/gpt-big:H {2}\+1 숨김/, "an agent routed by categories inherits the builtin deep chain")
  assert.match(reviewer, /적용: claude\/claude-opus:H {2}\[categories\]/, "and runs the effective deep chain")
  const fresh = makeEditor({ raw: {} })
  select(fresh.editor, "deep")
  assert.match(screen(fresh.editor), /빌트인 \(OMO 1\.2\.3\): codex\/gpt-big:H {2}\+1 숨김/)
  press(fresh.editor, "h")
  assert.match(screen(fresh.editor), /빌트인 \(OMO 1\.2\.3\): codex\/gpt-big:H → kimi\/k3\(미연결\)/)
})

test("adding a connected model through the picker and effort view, then moving, re-efforting and removing rungs", () => {
  const { editor } = makeEditor()
  select(editor, "writing")
  press(editor, KEY.enter)
  assert.match(screen(editor), /writing · base 편집 · 상태 빌트인/)
  press(editor, "a", ..."opus")
  assert.match(screen(editor), /모델 선택 \(추가\) · 필터: opus▏ · 1\/6/)
  assert.match(screen(editor), /▸ claude\/claude-opus\s+Claude Opus/)
  press(editor, KEY.enter)
  assert.match(screen(editor), /effort 선택 · claude\/claude-opus/)
  assert.match(screen(editor), /▸ high$/m, "high is preselected when offered")
  press(editor, KEY.enter)
  assert.deepEqual(editor.pending(), [{ section: "categories", name: "writing", disable: null, chain: ["anthropic-subscription/claude-fable:low", "anthropic-subscription/claude-opus:high"] }])
  assert.match(screen(editor), /▸ {2}2\. claude\/claude-opus:H/)
  press(editor, "K")
  assert.deepEqual(editor.pending()[0].chain, ["anthropic-subscription/claude-opus:high", "anthropic-subscription/claude-fable:low"])
  press(editor, KEY.shiftDown)
  assert.deepEqual(editor.pending()[0].chain, ["anthropic-subscription/claude-fable:low", "anthropic-subscription/claude-opus:high"])
  press(editor, "e", KEY.down, KEY.enter)
  assert.deepEqual(editor.pending()[0].chain, ["anthropic-subscription/claude-fable:low", "anthropic-subscription/claude-opus:xhigh"])
  press(editor, KEY.up, KEY.enter, ..."gpt big", KEY.enter, KEY.enter)
  assert.deepEqual(editor.pending()[0].chain, ["chatgpt-subscription/gpt-big:low", "anthropic-subscription/claude-opus:xhigh"], "Enter on a rung replaces its model")
  press(editor, "a", ..."opus", KEY.enter, KEY.down, KEY.enter)
  assert.match(screen(editor), /claude\/claude-opus:E은 이미 2번째에 있습니다/)
  press(editor, "d")
  assert.deepEqual(editor.pending()[0].chain, ["chatgpt-subscription/gpt-big:low"], "after deleting the last rung the cursor moves up")
  press(editor, "d")
  assert.deepEqual(editor.pending(), [], "removing every rung follows the builtin again, which base already did: no change")
  press(editor, KEY.esc)
  assert.match(row(screen(editor), "writing"), /writing\s+-\s+빌트인\s+claude\/claude-fable:L$/)
})

test("follow, disable, undo and Tab keep separate drafts per layer; user-only nodes keep their last model", () => {
  const { editor } = makeEditor({ profile: "work" })
  select(editor, "quick")
  press(editor, "r")
  assert.deepEqual(editor.pending(), [{ profile: "work", section: "categories", name: "quick", disable: true, chain: null }])
  press(editor, "x")
  assert.deepEqual(editor.pending()[0], { profile: "work", section: "categories", name: "quick", disable: null, chain: null })
  assert.match(row(screen(editor), "quick"), /빌트인\s+\*\s+codex\/gpt-mini:L/)
  press(editor, KEY.tab)
  assert.match(screen(editor), /편집 레이어: base \[native\]/)
  select(editor, "deep")
  press(editor, "r")
  assert.equal(editor.pending().length, 2)
  press(editor, "u")
  assert.equal(editor.pending().length, 1)
  select(editor, "implementer")
  press(editor, "r")
  assert.match(screen(editor), /빌트인 기본값이 없는 노드라 따를 대상이 없습니다/)
  press(editor, KEY.enter, "d")
  assert.match(screen(editor), /마지막 모델은 지울 수 없습니다/)
  assert.equal(editor.pending().length, 1)
})

test("save passes the exact drafts; an external change needs a second s; closing with drafts asks once", () => {
  let external = true
  const { editor, saves, closed } = makeEditor({
    saveResult: (drafts, confirm) => external && !confirm ? { status: "external-change" } : { status: "saved", text: "{}", count: drafts.length, backup: "x.bak" },
    configPath: "C:/home/.omo/omo.jsonc",
  })
  select(editor, "writing")
  press(editor, "x", "q")
  assert.match(screen(editor), /저장 안 된 변경 1건: q\/Esc를 한 번 더 누르면 버리고 닫습니다/)
  press(editor, KEY.down)
  assert.deepEqual(closed, [], "any other key cancels the close")
  press(editor, "s")
  assert.match(screen(editor), /편집기를 연 뒤 바뀌었습니다. s를 한 번 더/)
  press(editor, "s")
  assert.deepEqual(saves.map(save => save.confirm), [false, true])
  assert.deepEqual(saves[1].drafts, [{ section: "categories", name: "writing", disable: true }])
  assert.match(screen(editor).replace(/\s+/g, " "), /저장했습니다: 1건 \(C:\/home\/\.omo\/omo\.jsonc, 이전 파일은 \.bak\)\. 편집기를 닫으면 OMO가 다시 불러와 적용합니다/)
  external = false
  press(editor, "q")
  assert.deepEqual(closed, [{ saved: 1 }])
})

test("builtin changes since the last review are badged and c marks them reviewed", () => {
  const drift = { since: "1.0", count: 2, sections: { categories: {
    writing: { kind: "new", after: ["anthropic-subscription/claude-fable:low"] },
    deep: { kind: "changed", before: ["chatgpt-subscription/gpt-old"], after: ["chatgpt-subscription/gpt-big:high", "kimi/k3"] },
  } } }
  let reviewed = 0
  const { editor } = makeEditor({ drift, markReviewed: () => { reviewed++; return { count: 0, sections: {} } } })
  const text = screen(editor)
  assert.match(text, /빌트인 변경 \(OMO 1\.0에서 확인한 뒤\): 신규 1 \(writing\) · 변경 1 \(deep\) · c: 확인 처리/)
  assert.match(row(text, "writing"), /빌트인\s+NEW/)
  assert.match(row(text, "deep"), /커스텀\s+변경됨/)
  select(editor, "deep")
  const detail = screen(editor)
  assert.match(detail, /이전 빌트인 \(OMO 1\.0\): codex\/gpt-old/)
  assert.match(detail, /빌트인이 바뀌었지만 내 체인이 그 위를 덮고 있습니다/)
  press(editor, "c")
  assert.equal(reviewed, 1)
  assert.doesNotMatch(screen(editor), /빌트인 변경 \(/)
  press(editor, "c")
  assert.equal(reviewed, 1, "nothing left to review")
})

test("without a model registry nothing is hidden and no model can be picked", () => {
  const { editor } = makeEditor({ raw: {}, availability: availabilityOf(undefined) })
  assert.match(screen(editor), /구독 정보를 읽지 못해 모든 후보를 표시합니다 \(no model registry in this context\)/)
  select(editor, "deep")
  assert.match(row(screen(editor), "deep"), /codex\/gpt-big:H → kimi\/k3$/)
  press(editor, KEY.enter, "a")
  assert.match(screen(editor), /연결된 모델 목록이 없어 새 모델을 고를 수 없습니다/)
  press(editor, "e", KEY.enter)
  assert.equal(editor.pending().length, 0, "the effort view still opens; choosing the same effort changes nothing")
})

test("adjacent rungs of one model with different effort are flagged", () => {
  const { editor } = makeEditor({ raw: { categories: { writing: { models: ["anthropic-subscription/claude-opus:high", "anthropic-subscription/claude-opus:low"] } } } })
  select(editor, "writing")
  assert.match(row(screen(editor), "writing"), /커스텀\s+⚠/)
  press(editor, KEY.enter)
  assert.match(screen(editor), /1·2번: 같은 모델 claude-opus의 effort만 다릅니다/)
})

test("every rendered line is exactly the viewport width in every view, styled or not", () => {
  const theme = { fg: (color, text) => `\x1b[3${color.length % 8}m${text}\x1b[0m`, bold: text => `\x1b[1m${text}\x1b[22m` }
  for (const styled of [undefined, theme]) {
    for (const width of [19, 24, 40, 80, 140]) {
      const { editor } = makeEditor({ profile: "work", theme: styled, rows: () => 24, warnings: ["프로젝트 설정 C:/very/long/path/.omo/omo.jsonc도 라우팅을 정합니다"] })
      select(editor, "writing", width)
      const views = [editor.render(width)]
      press(editor, KEY.enter)
      views.push(editor.render(width))
      press(editor, "a")
      views.push(editor.render(width))
      press(editor, KEY.enter)
      views.push(editor.render(width))
      for (const lines of views) {
        // 80% of 24 rows: the overlay keeps a gap above it for omo's inline start offset.
        assert.ok(lines.length <= 19, `height ${lines.length} at 24 rows`)
        for (const line of lines) assert.equal(cells(line), width, `width ${width}: ${JSON.stringify(strip(line))}`)
      }
      if (styled) assert.ok(views[0].some(line => line.includes("\x1b[")), "styling reaches the output")
    }
  }
})

test("a frame with the title in its top edge marks the overlay at every width; a view too small for it goes unframed", () => {
  for (const width of [20, 40, 80, 140]) {
    const lines = makeEditor({ profile: "work" }).editor.render(width).map(strip)
    assert.match(lines[0], width >= 40 ? /^╭─ 라우팅 편집 · OMO 1\.2\.3 .* ─+╮$/ : /^╭─ 라우팅 편집.* ─+╮$/, `width ${width}`)
    assert.match(lines.at(-1), /^╰─+╯$/)
    assert.ok(lines.slice(1, -1).every(line => /^│ .* │$|^├─+┤$/.test(line)), `width ${width}: ${JSON.stringify(lines.find(line => !/^│ .* │$|^├─+┤$|^[╭╰]/.test(line)))}`)
    assert.ok(lines.filter(line => /^├─+┤$/.test(line)).length >= 2, "section rules join the frame")
  }
  assert.doesNotMatch(strip(makeEditor().editor.render(19)[0]), /╭/, "under 20 cells")
  assert.doesNotMatch(strip(makeEditor({ rows: () => 12 }).editor.render(80)[0]), /╭/, "under 10 rows of overlay")
})

test("each node's description is listed beside it while the chain keeps room, and always shown in the detail pane", () => {
  const wide = screen(makeEditor().editor, 140)
  assert.match(row(wide, "quick"), /^ {2}quick\s+Fast small work…\s+빌트인\s/)
  assert.match(row(wide, "implementer"), /implementer\s+Writes production code\.\s+커스텀\s/)
  const narrow = makeEditor()
  select(narrow.editor, "quick", 80)
  const text = screen(narrow.editor, 80)
  assert.doesNotMatch(row(text, "quick"), /Fast small work/, "80 columns leave the chain its room")
  assert.match(text, /^quick: Fast small work…$/m)
  const marked = screen(makeEditor({ raw: { categories: { writing: { description: "**Loud** `code` text." } } } }).editor, 140)
  assert.match(row(marked, "writing"), /writing\s+Loud code text\.\s+빌트인\s/, "markdown emphasis is dropped")
})

test("kitty CSI-u letters work; ctrl/alt chords are never read as letters", () => {
  const { editor } = makeEditor()
  select(editor, "writing")
  press(editor, "\x1b[120u")
  assert.equal(editor.pending().length, 1, "CSI u 'x' toggles disable")
  press(editor, "\x1b[117;5u", "\x1b[117;3u")
  assert.equal(editor.pending().length, 1, "ctrl+u / alt+u are ignored")
  press(editor, "\x1b[117u")
  assert.equal(editor.pending().length, 0, "plain u undoes")
  press(editor, KEY.enter)
  assert.match(screen(editor), /writing · base 편집/)
  press(editor, "\x1b[127;3u", "\x1b[127;5u", "\x1b[13;5u", "\x1b[9;5u")
  assert.equal(editor.pending().length, 0, "alt/ctrl+Backspace, ctrl+Enter and ctrl+Tab do nothing")
  press(editor, "a", ..."opus", KEY.enter, KEY.enter, "\x1b[27;2;75~")
  assert.deepEqual(editor.pending()[0].chain, ["anthropic-subscription/claude-opus:high", "anthropic-subscription/claude-fable:low"],
    "xterm modifyOtherKeys shift+K moves the rung up")
  press(editor, "\x1b[127;129u")
  assert.deepEqual(editor.pending()[0].chain, ["anthropic-subscription/claude-fable:low"], "Backspace with Num Lock on still removes")
  press(editor, KEY.esc, "\x1b[9;65u")
  assert.match(screen(editor), /편집할 프로필이 없어 base만 편집합니다/, "Tab with Caps Lock on is still Tab")
})

test("^H is Backspace except under Windows Terminal, which sends it for ctrl+Backspace", () => {
  assert.equal(decodeKey("\b", undefined, {}), "backspace")
  assert.equal(decodeKey("\b", undefined, { WT_SESSION: "1" }), undefined)
})
