# omo-routing

[English](README.md)

`~/.omo/omo.jsonc`와 설치된 OMO 내장 기본값을 합친 **유효 라우팅 후보**를
출력하는 Senpi/OMO 확장입니다. 현재 프로필, 지정한 프로필, 또는 base의
메인 세션·카테고리·에이전트 체인을 보여줍니다. 사용자 설정 파일이 없어도
동작하며, 프로바이더 인증이나 가용성은 검사하지 않습니다.

## 하는 일

```
/routing            현재 프로필 (OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR 끝 부분; 없으면 base)
/routing <profile>  해당 프로필의 오버레이를 base 설정 위에 적용한 결과
/routing base       base 설정만, 프로필 오버레이 없음
/routing models     모델별 담당 카테고리를 폴백 차수별로 표시
/routing off        위젯 숨기기 (인자 없는 /routing 도 다시 누르면 숨겨짐)
/routing help       모든 형식의 사용법 (-h / --help 도 동일)
```

위젯은 `/reload` 와 세션 시작 시에도 지워집니다.

존재하지 않는 프로필 이름을 주면 사용 가능한 프로필 목록을 담은 오류가
납니다.

### 모델별 담당 카테고리

`/routing models`는 현재 프로필을 사용합니다. 지정한 오버레이는
`/routing models --profile <name>` (또는 `-p <name>`), base는
`/routing models --base`로 조회합니다.

`1차`, `2차`, `3차` 등의 섹션은 각 카테고리의 유효 체인에서 첫 번째,
두 번째, 세 번째 이후 후보에 대응합니다. 각 섹션은
`모델 | 프로바이더 | 담당 카테고리` 순서의 표입니다.
프로바이더가 달라도 정식 모델 ID와 노력 수준이 같으면 한 행으로 묶으며,
표시용 축약은 집계 기준에 영향을 주지 않습니다.
내장 `{provider-a|provider-b}` 그룹은 한 차수로 계산하지만,
설정에 별개로 나열한 후보는 각각 별도 차수입니다.
같은 모델이 여러 차수에 등장하면 각 섹션에 그대로 표시합니다.

활성 카테고리만 집계하며 메인 세션과 에이전트 체인은 포함하지 않습니다.
필요한 곳에 내장 기본값을 적용한 설정상 후보를 보여주는 것이며,
실행 이력이나 프로바이더 가용성을 뜻하지 않습니다.
긴 셀은 줄바꿈하고 좁은 화면에서는 열 순서대로 세로 배치합니다.
설정 파일은 수정하지 않습니다.

### 체인 편집

```
/routing set    <name> <model...>   체인을 정확히 이 단계들로 교체 (폴백 순서대로)
/routing set    <name> <n> <model...>   n번째 단계만 교체 (1 = 첫 단계, models 뷰의 1차와 같은 번호)
/routing prepend <name> <model...>  맨 앞에 단계 삽입
/routing add    <name> <model...>   단계 추가 (중복은 건너뜀)
/routing remove <name> <model...>   단계 제거
```

- `set <n>` 과 `prepend` 에서는 이미 체인에 있는 모델을 주면 두 번 나오지
  않고 새 위치로 이동합니다. `add` 는 기존 단계를 그대로 둡니다. 체인 길이를
  넘는 `set <n>` 은 오류이며 아무것도 쓰지 않습니다. `<n>` 은 `set` 에서만
  받습니다.

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
- 편집 기준은 *유효* 체인(프로필이 base를 덮고 필요한 곳에 내장 기본값을
  적용한 결과)입니다. `add`/`remove`는 상속된 후보를 선택한 레이어에
  실체화합니다. 내장 프로바이더 대안은 선언 순서의 명시적
  `provider/model[:variant]` 문자열로 펼쳐지므로, 편집하면 기본값이
  사용자 설정의 순서 있는 목록으로 바뀝니다. 이미 설정된 체인에는 별도로
  표시된 에이전트 폴백 분기를 추가하지 않습니다. 카테고리/에이전트 모델을
  모두 제거하면 내장 기본값이 다시 적용될 수 있습니다.
- 편집에는 기존 omo.jsonc/omo.json이 필요합니다. 기본값을 표시하는 것만으로
  설정 파일을 만들지는 않습니다.

편집은 omo.jsonc 텍스트에 바이트 오프셋 단위로 적용됩니다. 주석, 키 순서,
건드린 값의 인라인/여러 줄 스타일이 보존되고, 새 항목은 주변 들여쓰기를
따릅니다. 기록 전에 이전 파일을 `omo.jsonc.bak` 으로 복사하고, 결과를 다시
파싱해 검증한 뒤에만 씁니다. 그 다음 기록한 레이어 기준으로 리포트를 다시
그리며, 맨 위에 `wrote <label> in profile <name>|base[ [senpi]]: <chain>` 한
줄이 붙습니다 (`[senpi]` 는 그 섹션에 기록했을 때만 표시). 변경은 호스트가
다음에 omo.jsonc 를 읽을 때 반영됩니다. 형식이 잘못된 편집은
`/routing help` 를 가리키는 오류가 됩니다.

리포트 구성:

- `config profile: ...   available profiles: ...` — 적용된 설정 오버레이와
  사용자 설정의 `profiles`에 정의된 이름입니다. `base (no overlay)`는
  모델 선택이 아니며, `none defined`는 이름 있는 설정 오버레이가 없다는 뜻입니다.
- `main model chain (model_profile): ...` — 별개인 메인 세션 모델 체인 선택입니다.
  설정하지 않으면 호스트/세션 모델을 그대로 두며, 내장 메인 프로필을 자동으로
  선택하지 않습니다.
- `user config:` — 읽은 파일 경로 또는 설정 파일이 없다는 명시적 안내입니다.
- `builtin defaults:` — 로드한 설치 소스 경로입니다. 소스가 없거나 지원되지
  않으면 경고와 설정된 체인만 표시합니다. 탐색 실패 시 기본값을 사용 중이라고
  표시하지 않습니다.
- `warning:`은 환경변수로 선택한 프로필이 없을 때도 표시됩니다(base로 대체).
- `main (<name>)`, `categories:`, `agents:` — 선택한 메인 체인과 정렬된
  카테고리/에이전트 행입니다. 설정 파일에 없는 내장 항목도 포함됩니다.

각 섹션은 `카테고리명 | 설명 | 라우팅 | 변경여부` 순서의 4열 표로
표시합니다. 긴 값은 셀 안에서 줄바꿈합니다.
변경여부는 유효 라우팅을 OMO 내장 라우팅과 비교한 결과입니다.
같으면 `기본`, 다르면 `변경`, 내장 기본값을 읽지 못하면 `확인 불가`로
표시합니다. 사용자 설정 항목이 있다는 이유만으로 변경으로 판단하지 않으며,
모델 순서와 노력 수준도 비교에 포함합니다.
설명은 설정의 `description`, `display_name`, 설치된 내장 역할 설명 순으로
사용하며, 없으면 `-`로 표시합니다. 첫 문장과 최대 60개 터미널 셀 너비로
요약합니다.

라우팅 셀은 `provider/model:variant → next → ...` 체인과 출처를 보여줍니다.
출처는 `configured`, `builtin`, `configured + builtin`, `categories`
(에이전트가 카테고리 라우팅을 상속), 또는 `unresolved`입니다. 비활성 항목은
`(disabled)`로 표시합니다. 선택된 메인 프로필이 비어 있어도 행을 생략하지
않습니다. 빈 카테고리/에이전트 섹션은 생략합니다.

체인 축약은 **표시 전용**이며 내장 프로바이더 그룹, 폴백 분기, 편집 결과에도
적용됩니다. 프로바이더 범례: `codex` = `openai-codex`, `claude` =
`claude-sdk-oauth`, `gh` = `github-copilot`. `devin`을 포함한 나머지는
그대로 표시합니다. 노력 수준 범례: `X` = max, `E` = xhigh, `H` = high,
`M` = medium, `L` = low, `O` = off 또는 none, `mi` = minimal, `au` = auto.
마지막 `:effort` 접미사만 줄이며, `swe-2-high` 같은 모델 이름과
알 수 없는 프로바이더/노력 수준 값은 원문을 보존합니다.
객체형 모델 항목은 `reasoning`에서 노력 수준을 읽고, 없으면 `variant`를
사용합니다. 체인 편집 후 정식 모델 문자열에도 이 노력 수준을 보존합니다.
`set`/`add`/`remove`에는 전체 정식 ID를 사용하세요. 축약 표기는 입력 별칭이
아니며, 파싱·일치 판정·저장 ID는 바뀌지 않습니다. 범례는 `/routing help`에도
있으며 리포트마다 반복하지 않습니다.

`{provider-a|provider-b}/model`은 하나의 내장 단계 안의 프로바이더 대안이며,
별개의 재시도 단계가 아닙니다. 카테고리 기본값은 우선 모델 다음에 내장 폴백
테이블을 표시합니다. 설정된 에이전트에는 자체 후보를 해석할 수 없을 때 쓰는
라우팅 셀 안에 `builtin fallback: ...` 줄이 별도로 표시될 수 있습니다. 가용성 검사 전
후보 목록이므로, 모든 모델이 실행된다는 보장이나 현재의 실제 재시도 체인은 아닙니다.

## 설정 해석

설정 오버레이는 `omo-task.js`의 규칙을 따릅니다:

- 프로필 이름: `OMO_PROFILE` → `OCX_PROFILE` → `OPENCODE_CONFIG_DIR` 이
  `profiles/<name>` 으로 끝날 때 그 basename.
- 레이어 병합 순서: base → `[senpi]` → `profiles.<name>` base →
  `profiles.<name>.[senpi]`. 객체는 깊은 병합, 배열과 스칼라는 교체.
- `omo.jsonc` 의 주석(`//`, `/* */`)은 파싱 전에 제거됩니다. `.jsonc` 가
  없으면 `omo.json` 을 사용합니다.
- 카테고리의 비어 있지 않은 `models`는 `model`보다 우선합니다. 그렇지 않으면
  `model`과 `fallback_models`를 적용합니다. 명시적 우선 모델이 없으면 내장
  우선 모델, 설정된 폴백, 내장 단계 순입니다. 에이전트는 `model` 다음에
  `models`를 두고, 이후 상속된 카테고리/내장 폴백을 사용할 수 있습니다.
  메타데이터만 있거나 빈 카테고리/에이전트 오버라이드는 기본값을 유지합니다.
- 사용자 `model_profiles.<name>`은 모델이 비어 있어도 내장 프로필 전체를
  대체합니다. `model_profile`에 `provider/model`을 직접 지정할 수도 있습니다.

내장 기본값은 호스트 런처의 `OMO_BIN`을 기준으로
`../plugin/extensions/omo-task.js`(카테고리, 에이전트, 카테고리 상속)와
`omo.js`(메인 모델 프로필)에서 찾습니다. 리터럴 데이터만 읽고 번들을
import하거나 실행하지 않으며, 확장에 모델 목록을 복사하지 않습니다.
어댑터는 축약된 변수 이름이 아니라 설치된 번들의 테이블 형태를 인식합니다.
파일 누락, 지원하지 않는 표현식, 모호한 테이블은 경고로 표시합니다.
OMO 업그레이드 후에는 소스 파일과 실행 중인 호스트가 일치하도록
호스트를 재시작하거나 다시 로드하세요.

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

- 실제 프로바이더 상태(레지스트리 가용성, `auth.json` 자격증명,
  `credential-pool-state.json` 백오프)는 전혀 확인하지 않습니다. 내장
  모델/프로바이더 ID는 레지스트리 별칭 정규화 전 OMO 선언을 그대로 사용하고,
  위의 표시용 축약만 적용합니다. 세션/CLI 모델 오버라이드나 런타임 재시도 필터링은 추론하지 않습니다.
- 내장 기본값에는 인식 가능한 설치 소스 구조와 `OMO_BIN`이 필요합니다.
  단독 Senpi나 호환되지 않는 향후 번들에서는 기본값을 추측하지 않고
  경고와 설정된 체인만 표시합니다.
- 쓰기는 `set`/`add`/`remove` 뿐이며, 하나의 `models` 배열(그리고 `set` 일 때
  형제 `model` 키)만 건드립니다. 프로바이더 상태는 절대 건드리지 않습니다.
  `/routing profile <name>` 같은 프로필 전환은 없습니다: 프로필은 호스트가
  시작될 때 환경변수로 고정됩니다.
- 호스트가 `ctx.ui.setWidget` 을 지원하면 표는 에디터 위에 표시되고 토스트는
  뜨지 않습니다. 지원하지 않으면 리포트 전체가 `ctx.ui.notify` 로 갑니다.
  위젯은 문자열 배열이 아니라 컴포넌트 팩토리(`render(width)`)로 넘기는데,
  senpi 가 문자열 배열 위젯을 10줄(`MAX_WIDGET_LINES`)로 자르기 때문입니다.
  모든 줄은 터미널 셀 너비에 맞춰 `→` 경계, 프로바이더 그룹의 `|`, 공백 순으로 줄바꿈됩니다.
  긴 모델 ID, 프로바이더 그룹, 경로는 필요한 경우에만 문자소 경계에서
  나뉘며 잘리지 않습니다. 표의 이어지는 줄은 각 열 안에 정렬하며,
  4열을 표시할 공간이 없으면 각 행의 셀을 같은 순서로 세로 배치합니다.
  CJK와 이모지는 두 셀로 계산하고 결합 문자는 원래 문자와
  함께 유지하며, `→`처럼 폭이 모호한 문자는 한 셀로 계산합니다.
  한 셀 너비의 화면에서는 더 넓은 문자를 손실 없는 `\u{...}` 코드 포인트
  이스케이프로 표시합니다.
