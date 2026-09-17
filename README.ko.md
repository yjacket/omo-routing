# omo-routing

[English](README.md)

`~/.omo/omo.jsonc`에 **설정된** 모델 라우팅을 출력하는 Senpi/OMO 확장입니다.
현재 프로필, 지정한 프로필, 또는 base 설정의 카테고리별·에이전트별 모델
체인을 보여줍니다.

## 하는 일

```
/routing            현재 프로필 (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR 끝 부분; 없으면 base)
/routing <profile>  해당 프로필의 오버레이를 base 설정 위에 적용한 결과
/routing base       base 설정만, 프로필 오버레이 없음
/routing off        위젯 숨기기 (인자 없는 /routing 도 다시 누르면 숨겨짐)
/routing help       모든 형식의 사용법 (-h / --help 도 동일)
```

위젯은 `/reload` 와 세션 시작 시에도 지워집니다.

존재하지 않는 프로필 이름을 주면 사용 가능한 프로필 목록을 담은 오류가
납니다.

### 체인 편집

```
/routing set    <name> <model...>   체인을 정확히 이 단계들로 교체 (폴백 순서대로)
/routing add    <name> <model...>   단계 추가 (중복은 건너뜀)
/routing remove <name> <model...>   단계 제거
```

- `<model>` 은 `provider/model[:variant]` 형식입니다. 예:
  `openai-codex/gpt-5.6-sol:high`.
- `<name>` 은 `main` (유효한 `model_profile` 의 체인), `main:<model_profile>`,
  카테고리 이름, 에이전트 이름, 또는 명시적인 `category:<name>` /
  `agent:<name>` 입니다. 접두사 없는 이름은 유효 설정의 카테고리나 에이전트
  중 정확히 하나와 일치해야 하며, 명시적 형식은 새 항목을 만듭니다.
- `--profile <name>` (짧게 `-p <name>`) 또는 `--base` 로 기록할 레이어를
  고릅니다. 기본값은 현재 프로필(리포트와 같은 규칙으로 결정)이고, 프로필이
  없으면 base 입니다. 환경변수가 가리키는 프로필이 파일에 없으면 base 에
  조용히 쓰지 않고 오류를 냅니다.
- 선택한 레이어 안에서 체인은
  `[senpi].<categories|agents|model_profiles>.<name>.models` 에 기록됩니다
  (해당 레이어가 이미 루트에 그 키들을 두고 있으면 루트에 기록). `set` 은
  단수형 `model` 키도 제거해서 체인이 정확히 지정한 값이 되게 합니다.
- 편집 전 기준이 되는 체인은 *유효* 체인(프로필이 base 를 덮은 결과)입니다.
  그래서 base 에서 상속된 항목에 `add`/`remove` 를 하면 병합된 결과가
  프로필에 실체화됩니다.

편집은 omo.jsonc 텍스트에 바이트 오프셋 단위로 적용됩니다. 주석, 키 순서,
건드린 값의 인라인/여러 줄 스타일이 보존되고, 새 항목은 주변 들여쓰기를
따릅니다. 기록 전에 이전 파일을 `omo.jsonc.bak` 으로 복사하고, 결과를 다시
파싱해 검증한 뒤에만 씁니다. 그 다음 기록한 레이어 기준으로 리포트를 다시
그리며, 맨 위에 `wrote <label> in profile <name>|base[ [senpi]]: <chain>` 한
줄이 붙습니다 (`[senpi]` 는 그 섹션에 기록했을 때만 표시). 변경은 호스트가
다음에 omo.jsonc 를 읽을 때 반영됩니다. 형식이 잘못된 편집은
`/routing help` 를 가리키는 오류가 됩니다.

리포트 구성:

- `profile: <p>   model_profile: <mp>   available: <a, b>` — 실제 적용된
  프로필, 해석된 `[senpi].model_profile`, omo.jsonc 에 정의된 모든 프로필
- `warning:` — 요청한 프로필이 없을 때 표시 (base 설정을 대신 보여줌)
- `main (<name>)  ...` — `model_profiles.<name>.models` 의 메인 세션 체인.
  `model_profile` 이 없거나 체인이 비어 있으면 생략
- `categories:` — `categories.<name>` 마다 한 줄, 정렬됨
- `agents:` — `agents.<name>` 마다 한 줄 (`explore`, `librarian`,
  `plan-reviewer` 같은 서브에이전트 타입; omo-task.js 는
  `agents.<subagentType>` 을 읽음), 정렬됨

각 체인은 한 줄입니다: `name  provider/model:variant -> next -> ...`,
왼쪽에서 오른쪽으로 폴백 순서이며 이름은 공통 열 너비로 패딩됩니다. 모델이
없는 항목은 `(no chain configured)` 로 표시됩니다. 카테고리/에이전트 블록은
비어 있으면 생략됩니다.

## 설정 해석

`omo-task.js` 와 정확히 같은 규칙입니다:

- 프로필 이름: `OMO_PROFILE` → `OCX_PROFILE` → `OPENCODE_CONFIG_DIR` 이
  `profiles/<name>` 으로 끝날 때 그 basename.
- 레이어 병합 순서: base → `[senpi]` → `profiles.<name>` base →
  `profiles.<name>.[senpi]`. 객체는 깊은 병합, 배열과 스칼라는 교체.
- `omo.jsonc` 의 주석(`//`, `/* */`)은 파싱 전에 제거됩니다. `.jsonc` 가
  없으면 `omo.json` 을 사용합니다.

## 설치

클론할 필요 없이 파일 하나를 OMO 확장 디렉터리로 받으면 됩니다.

```sh
# *nix / Git Bash
mkdir -p ~/.omo/agent/extensions && curl -fsSL https://raw.githubusercontent.com/yjacket/omo-routing/master/extension/routing.ts -o ~/.omo/agent/extensions/routing.ts
```
```powershell
# Windows
New-Item -Force -ItemType Directory "$HOME\.omo\agent\extensions" | Out-Null; iwr https://raw.githubusercontent.com/yjacket/omo-routing/master/extension/routing.ts -OutFile "$HOME\.omo\agent\extensions\routing.ts"
```

클론한 상태라면 `cp extension/routing.ts ~/.omo/agent/extensions/`.

그 뒤 실행 중인 세션에서 `/reload` (또는 재시작) 하고 `/routing` 을
실행하세요.

## 테스트

```sh
node --test
```

Node ≥ 22.6 필요: 테스트는 `.mjs` 이며 Node 내장 타입 스트리핑으로
`extension/routing.ts` 를 직접 import 합니다. 가짜 `pi`/`ctx` 하네스가 명령
레지스트리와 픽스처 `omo.jsonc` 가 든 임시 `$HOME` 을 제공합니다. senpi 도,
LLM 호출도 없습니다.

## 한계

- 설정된 라우팅만 다룹니다: 체인은 omo.jsonc 에 적힌 그대로 출력됩니다. 실제
  프로바이더 상태(레지스트리 가용성, `auth.json` 자격증명,
  `credential-pool-state.json` 백오프)는 전혀 확인하지 않습니다.
- omo.jsonc 가 아닌 `omo-task.js` 안에 내장된 카테고리 기본 체인은 보여주지
  않습니다. omo.jsonc 에 `models` 가 없는 카테고리는
  `(no chain configured)` 로 표시됩니다.
- 쓰기는 `set`/`add`/`remove` 뿐이며, 하나의 `models` 배열(그리고 `set` 일 때
  형제 `model` 키)만 건드립니다. 프로바이더 상태는 절대 건드리지 않습니다.
  `/routing profile <name>` 같은 프로필 전환은 없습니다: 프로필은 호스트가
  시작될 때 환경변수로 고정됩니다.
- 호스트가 `ctx.ui.setWidget` 을 지원하면 표는 에디터 위에 표시되고 토스트는
  뜨지 않습니다. 지원하지 않으면 리포트 전체가 `ctx.ui.notify` 로 갑니다.
  위젯은 문자열 배열이 아니라 컴포넌트 팩토리(`render(width)`)로 넘기는데,
  senpi 가 문자열 배열 위젯을 10줄(`MAX_WIDGET_LINES`)로 자르기 때문입니다.
  뷰포트보다 넓은 행은 `->` 경계에서 줄바꿈되고, 이어지는 줄은 체인 열에
  맞춰 들여쓰기됩니다.
