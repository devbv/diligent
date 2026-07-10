---
id: P072-NOTES-KO
parent: P072
created: 2026-07-10
status: implemented
---

# P072 구현 정리 (인수인계 / 알아둘 점)

`docs/plan/feature/P072-procedural-toolification-handoff.md` 설계를 구현 완료한 내용 요약입니다.
OVERDARE 절차적(procedural) Luau 런타임을 Studio 에이전트용 툴로 노출했습니다.

## 브랜치 / 커밋

- 새 브랜치: `p072-procedural-toolification` (origin 에 푸시됨).
- 베이스: `hello` = `origin/main` + `tt` 커밋(P068 절차적 생성 기능). P072 는 P068 위에 쌓이므로,
  이 브랜치에는 **P068 + P072 가 함께** 들어 있습니다(둘은 분리 불가).
- `tt` 커밋은 P068 시절 커밋(작성자 본인)이라 메시지가 부실합니다. 리뷰 편의상 필요하면 나중에 reword 하세요.

## 에이전트에 새로 노출된 툴 (수명(lifetime) 기준으로 분리)

| 툴 | 용도 | 동작 |
|---|---|---|
| `studiorpc_procedural_run` | 일회성 | 스크립트를 현재 씬에 대해 1회 실행하고 결과를 적용. `script`(인라인) 또는 `scriptPath`(파일), 선택 `targetGuid`(기본=Workspace 전체), 선택 `parameters`. 저장 안 함. |
| `studiorpc_procedural_model_save` | 영속화 | 스크립트+매니페스트를 `<project>/.overdare/procedural/` 에 저장. dry-run 으로 검증. `-- generationId:` 주석 필수. 씬은 안 건드림. |
| `studiorpc_procedural_model_run` | 영속 모델 실행 | `id` 로 조회 → 실행 → 매니페스트 기반으로 **이전 생성물 삭제 후 재적용**(멱등). 반복 실행해도 중복 안 됨. |
| `studiorpc_procedural_model_list` | 조회 | 저장된 모델 목록(id/파라미터/적용여부/수정시각). |

## 내부 아키텍처

```
L0 runProceduralScript(script, {scene?, parameters?, targetGuid?}) -> ProceduralOp[]   (가드레일 적용)
L1 applyProceduralOps(ops, {targetGuid, cwd}) -> {added, updated, deleted, rootGuids}   (add/update/delete)
```

- **생성(generate)/변형(transform)은 툴이 아니라 스크립트 내용의 차이**입니다. 같은 엔진이 둘 다 처리.
- 변형: 런너가 현재 씬 하위트리를 `workspace` 전역으로 주입 → 스크립트가 `workspace:GetDescendants()`,
  `part.CFrame -= …`, `inst:Destroy()` 로 기존 오브젝트를 읽고 수정. TS 쪽에서 **최종 트리 vs 스냅샷을 diff**
  하여 op(add/update/delete)를 도출합니다(스크립트에는 op 개념이 아예 없음).

주요 파일:
- `sidecar/src/procedural/`: `limits.ts`(가드레일), `ops.ts`(end-state diff), `manifest.ts`(영속화),
  `runtime.ts`(`runProceduralScript` 추가), `luau/ovdr-shim.lua`(`Ovdr.injectScene`+guid 직렬화), `luau/runner.lua`(workspace 전역).
- `sidecar/src/tools/studiorpc/tools/`: `procedural-apply.ts`(`applyProceduralOps`), `procedural-scene.ts`,
  그리고 툴 4개(`procedural-run-tool`, `procedural-model-{save,run,list}-tool`). `index.ts` 에 등록.

## ⚠️ 꼭 알아둘 점

1. **P1 전송 방식 = argv + 크기 가드 (되돌리지 마세요).**
   벤더 Luau 0.723 CLI 는 샌드박스라 `io`=nil, stdin 리더 없음, `os.getenv`=nil, `require` 는 절대경로/루트 밖
   `../` 불가(오직 `./`, 루트 내 `../`, `.luaurc` 의 `@alias` 만). 즉 핸드오프의 "임시파일/stdin 으로 입력 읽기"는
   **소스 트리에 파일을 쓰지 않는 한 구현 불가**. `ARG_MAX`≈1MB, 실제 스크립트 ~10KB 라 argv 로 충분.
   그래서 argv 유지 + `limits.ts` 의 `maxInputBytes`(512KB) 가드로 대체(사용자 승인). 파일/stdin 으로 "고치려" 하지 마세요.

2. **라이브러리는 프로젝트로 복사하지 않습니다.**
   실행은 항상 sidecar 의 `luau/` 디렉터리(cwd)에서 일어나고, `model_run` 은 저장된 스크립트를 텍스트로 읽어
   **소스 문자열을 argv 로** runner 에 넘깁니다. runner 가 `loadstring` 후 `script.Dependencies.*` 를 sidecar 에서
   주입. 프로젝트 폴더엔 **사용자 스크립트 원본 + 매니페스트만** 들어갑니다.
   → 부작용: `.overdare/procedural/scripts/*.lua` 는 **단독 실행용이 아님**(우리 runner 로만 실행 가능).

3. **라이브 apply 성공 경로는 실제 Studio 없이는 미검증.**
   성공 시 `level.apply` RPC(TCP)를 호출하므로 실 Studio 필요. 테스트는 그 직전까지 커버(arg 파싱, 한도,
   승인 거절, 순수 diff, 그리고 RPC 를 mock 한 상태에서 파일단위 apply 전체 — `model_run` 2회 실행 시 서브트리 1개
   유지 확인 포함). **실제 프로젝트 + Studio 로 한 번 돌려보는 게 다음 필수 단계.**

4. **핸드오프 후속 정리(2026-07-10, 사용자 요청으로 완료):**
   - `studiorpc_procedural_json_apply` **demote 완료** — 에이전트 툴 등록 제거 + 툴 파일/전용 테스트 삭제.
     JSON 파일 적용 기능은 신규 툴(`procedural_run`/`model_run`)이 스크립트를 직접 실행·적용하므로 표면에서 뺐고,
     공유 L1 은 `applyProceduralOps`. 필요하면 git 히스토리에서 복구 가능(escape hatch).
   - 디렉터리 리네임 **완료**: `src/procedural-model/` → `src/procedural/`, `test/procedural-model/` → `test/procedural/`
     (임포트 경로 전부 갱신). 단, 툴 파일명 `procedural-model-{save,run,list}-tool.ts` 는 "procedural **model**" 개념이라 유지.

5. **변형(transform) MVP 제약:**
   - 읽기/diff/쓰기 대상 속성 화이트리스트 = `CFrame`, `Size`, `Color`, `Material`, `WorldPivot`. 그 외는 안 건드림.
   - **기존 오브젝트 reparent(부모 변경) 미지원.** move/scale/recolor/delete/add 는 지원.

6. **저장 위치:** `<project>/.overdare/procedural/{scripts,models}/`. `generationId` 가 모델 식별자(파일명).
   경로 탈출 방지를 위해 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 만 허용.

## 검증 상태

- `tsc --noEmit` clean, `biome check` clean(touched paths), `bun test` **125 pass / 0 fail**.
- 커버: 가드레일(timeout kill·node 한도·input 크기), 순수 diff 7종, applier(delete→update→add·skip-missing),
  툴(arg 파싱·승인 거절·멱등 재실행), colosseum 대용량 스크립트 round-trip.

## Luau 인터프리터 패키징 (2026-07-10 완료)

지원 대상 = **windows-x64(amd64) + darwin-arm64** 로 확정.

- 벤더 바이너리(`vendor/luau/0.723/{darwin,win32,linux}/`)는 OS별로 커밋됨. darwin=arm64,
  win32=x86-64, linux=x86-64. **darwin 은 arm64 전용**(인텔 맥은 미지원 → fallback 필요).
- `build-overdare-sidecar.ts` 가 타깃별 인터프리터를 `assets/bin/`(`luau` 또는 `luau.exe`)으로 복사
  (exec bit 보존). `runtime.ts` 의 해석 순서: `OVDR_LUAU_BIN`/`LUAU_BIN` → 패키지 `assets/bin` →
  소스 `vendor/` → PATH `luau`. darwin-arm64 / windows-x64 빌드로 실제 복사·아키텍처 검증 완료.

## 추천 후속 작업

- 실 Studio 프로젝트로 `procedural_run`(변형) / `model_run`(멱등 재생성) 라이브 검증.
- 저장 스크립트 standalone 화(`.luaurc` alias) 검토(선택).
- (선택) 인텔 맥/ARM 리눅스 지원이 필요하면 darwin universal 또는 추가 벤더 바이너리 도입.
