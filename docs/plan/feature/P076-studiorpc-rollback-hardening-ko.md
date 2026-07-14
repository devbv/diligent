# StudioRPC 롤백 강화 & 특정 시점 롤백 구현 플랜 (한글 번역)

> 원본: [P076-studiorpc-rollback-hardening.md](P076-studiorpc-rollback-hardening.md) — 실행 시에는 영어 원본을 기준으로 하세요. 이 문서는 읽기 편의를 위한 번역본이며, 코드 블록은 원본과 동일합니다.

> **에이전트 작업자용:** 필수 서브스킬: superpowers:subagent-driven-development(권장) 또는 superpowers:executing-plans로 태스크 단위로 구현하세요. 스텝은 체크박스(`- [ ]`) 문법으로 추적합니다.

**목표:** studiorpc 롤백의 실패 경로를 강화하고(조용한 캡처 실패, 원자성 없는 복원, 롤백 취소 불가), 브레이크포인트 방식의 특정 시점 롤백을 추가한다: 모든 스냅샷에 사용자 프롬프트에서 파생한 라벨을 붙이고, 신규 `studiorpc_snapshot_list` 툴로 노출하며, `studiorpc_rollback`이 `snapshotId`를 받아 임의 지점으로 복원할 수 있게 한다.

**아키텍처:** 기존 스냅샷 설계(턴의 첫 맵 편집 직전 지연 캡처, `.ovdrjm` raw 바이트 복사, 파일시스템이 source of truth)는 유지한다. 스냅샷별 메타데이터 사이드카(`{sessionId}_{index}.json`)에 label/kind/createdAt을 추가한다. 롤백은 복원 전에 `pre-rollback` 안전 스냅샷을 캡처하고(롤백 취소 가능), `level.apply`를 복구 로직으로 감싸며(실패 시 안전 사본을 되돌려 디스크와 에디터의 일관성 유지), 어느 지점을 복원했는지 보고한다. 스냅샷은 캡처 때마다 세션당 상한으로 정리(prune)한다.

**기술 스택:** Bun + TypeScript, `bun:test`, zod. 신규 의존성 없음.

## 전역 제약

- 모든 코드, 주석, 테스트, 문서는 영어로 작성 (리포 AGENTS.md 컨벤션).
- 파일 헤더 주석은 기존 `// @summary ...` 스타일 사용.
- 베이스 브랜치: `feat/studiorpc-human-edits`; 작업 브랜치: `feat/studiorpc-rollback-hardening`.
- 테스트 실행 위치는 `apps/overdare-ai-agent/sidecar/`: `bun test test/tools/studiorpc-rollback.test.ts`.
- 기존 공개 헬퍼 시그니처는 optional 파라미터 추가만 허용, 기존 호출자를 깨면 안 됨.
- 스냅샷 파일명 형식 `{sessionId}_{index}.ovdrjm`은 불변 (하위 호환: `.json` 사이드카 없는 기존 스냅샷도 목록/복원이 계속 동작해야 함).

## 개선점 커버리지 맵

| 분석 항목 | 이 플랜의 위치 |
|---|---|
| (1) 원자성 없는 복원 (`level.apply` 실패가 onStop save에 의해 조용히 무효화) | Task 6 |
| (2) 조용한 캡처 실패 → 롤백이 예상보다 과거로 점프 | Task 4 (툴 출력에 경고 표출) + Task 6 (롤백 출력이 복원 지점을 명시) |
| (3) 롤백의 롤백 불가 | Task 6 (`pre-rollback` 안전 스냅샷) |
| (4) 1단계 롤백만 가능 | Task 5 (리스트 툴) + Task 6 (`snapshotId` 파라미터) |
| (5) 스냅샷 무한 축적 | Task 3 (prune) + Task 4 (캡처에 연결) |
| (6) 공유 `turnState`의 동시 세션 경합 | **범위 제외.** 툴이 자신의 세션을 식별할 수 없음(`ToolContext`에 세션 id 없음); 제대로 고치려면 런타임 전반의 배관이 필요. 단일 사용자 로컬 도구라 위험도 낮음. 후속 과제: `ToolContext`에 세션 id 배관, `turnState`를 세션별로 키잉, `findLatestSnapshot`을 호출 세션으로 스코핑. |
| (7) 롤백 후 에이전트 컨텍스트와 맵 상태의 괴리 | Task 6 (롤백 출력이 재조회를 지시하고 소멸 범위를 명시) |
| 브레이크포인트 / 요약 기반 특정 시점 롤백 | Task 1, 4, 5, 6 (프롬프트 파생 라벨 + 리스트 + 타겟 복원) |

**라벨 설계 노트:** 각 스냅샷에 붙는 "요약"은 편집 턴을 시작한 사용자 프롬프트다 (`UserPromptSubmit` 훅 입력의 `input.prompt`로 제공됨 — `packages/runtime/src/app-server/turn-handlers.ts:171` 참고). 사이드카에는 최대 2000자까지 저장하고, 사람에게 보이는 출력(리스트 툴, 승인 프롬프트, 롤백 결과)에서는 120자로 잘라 보여준다. 전문을 로컬에 저장하면 스냅샷 디렉토리가 자기완결적으로 유지된다 — 컴팩션에서 줄 번호와 엔트리가 살아남지 못하는 세션 트랜스크립트를 조회할 필요가 없다. LLM 요약은 사용하지 않는다. `// ponytail: prompt-prefix label; LLM summarization if labels prove too noisy`.

## 파일 구조

- 수정: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/snapshot.ts` — 메타데이터 기록, `listSnapshots`, `findSnapshotById`, kind 인지 `findLatestSnapshot`, `pruneSnapshots`.
- 수정: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/rollback-tool.ts` — `snapshotId` 파라미터, 안전 스냅샷, apply 실패 복구, 출력 강화.
- 생성: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/tools/snapshot-list-tool.ts` — 읽기 전용 `studiorpc_snapshot_list` 툴.
- 수정: `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/index.ts` — `turnState`에 프롬프트 라벨, 캡처 실패 경고, prune 연결, 리스트 툴 등록.
- 수정: `apps/overdare-ai-agent/sidecar/test/tools/studiorpc-rollback.test.ts` — 확장; 기존 테스트 1개의 단언이 변경됨 (Task 6 참고).

아래 모든 태스크는 이 경로들을 사용하며, 상대 경로 기준은 `apps/overdare-ai-agent/sidecar/`다.

---

### Task 1: 스냅샷 메타데이터 사이드카 + `listSnapshots`

**파일:**
- 수정: `src/tools/studiorpc/tools/snapshot.ts`
- 테스트: `test/tools/studiorpc-rollback.test.ts`

**인터페이스:**
- 소비: 기존 `snapshotsDir(cwd)`, `resolveOvdrjmPathFromUmap(cwd)`.
- 생산 (이후 태스크들이 이 정확한 형태에 의존):

```typescript
export type SnapshotKind = "turn" | "pre-rollback";

export interface SnapshotMeta {
  id: string;          // "{sessionId}_{index}"
  sessionId: string;
  index: number;
  createdAt: string;   // ISO timestamp
  label?: string;      // truncated user prompt, or "state before rollback"
  kind: SnapshotKind;
}

export interface SnapshotEntry extends SnapshotMeta {
  path: string;        // absolute path to the .ovdrjm copy
}

export interface CaptureOptions {
  label?: string;
  kind?: SnapshotKind; // default "turn"
}

export function captureSnapshot(cwd: string, sessionId: string, index: number, options?: CaptureOptions): string;
export function listSnapshots(cwd: string): SnapshotEntry[]; // newest first (mtime desc)
```

- [ ] **Step 1: 실패하는 테스트 작성**

`test/tools/studiorpc-rollback.test.ts`에 추가 (기존 파일 안에; `listSnapshots`는 새 `describe` 블록, 메타데이터 테스트는 기존 `describe("captureSnapshot", ...)` 안에):

```typescript
// Inside describe("captureSnapshot", ...):
  test("writes a metadata sidecar with label and kind", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess1", 0, { label: "make the tree bigger", kind: "turn" });
    const meta = JSON.parse(readFileSync(join(snapshotsDir(cwd), "sess1_0.json"), "utf-8"));
    expect(meta).toMatchObject({
      id: "sess1_0",
      sessionId: "sess1",
      index: 0,
      label: "make the tree bigger",
      kind: "turn",
    });
    expect(typeof meta.createdAt).toBe("string");
  });

  test("defaults kind to 'turn' and omits label when not given", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess1", 0);
    const meta = JSON.parse(readFileSync(join(snapshotsDir(cwd), "sess1_0.json"), "utf-8"));
    expect(meta.kind).toBe("turn");
    expect("label" in meta).toBe(false);
  });

// New top-level describe:
describe("listSnapshots", () => {
  test("returns entries newest-first with metadata merged in", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "first edit" });
    captureSnapshot(cwd, "sess", 1, { label: "second edit", kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    const entries = listSnapshots(cwd);
    expect(entries.map((e) => e.id)).toEqual(["sess_1", "sess_0"]);
    expect(entries[0]).toMatchObject({ label: "second edit", kind: "pre-rollback", index: 1 });
    expect(entries[1]).toMatchObject({ label: "first edit", kind: "turn", sessionId: "sess" });
  });

  test("legacy snapshots without a metadata file get kind 'turn' and mtime-based createdAt", () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old_3.ovdrjm"), "{}"); // pre-metadata snapshot
    const entries = listSnapshots(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "old_3", sessionId: "old", index: 3, kind: "turn" });
    expect(entries[0].label).toBeUndefined();
    expect(typeof entries[0].createdAt).toBe("string");
  });

  test("returns an empty array when the snapshots dir does not exist", () => {
    const cwd = projectDir();
    expect(listSnapshots(cwd)).toEqual([]);
  });
});
```

테스트 파일 상단의 `../../src/tools/studiorpc/tools/snapshot` import에 `listSnapshots`를 추가한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: FAIL — `listSnapshots`가 export되지 않음; 메타데이터 사이드카 파일이 존재하지 않음.

- [ ] **Step 3: `snapshot.ts` 구현**

import를 갱신하고 타입 + 구현을 추가한다. 변경 영역의 전체 새 내용:

```typescript
// @summary Rollback snapshot helpers: capture/restore .ovdrjm level snapshots with metadata.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@diligent/runtime";
import { resolveOvdrjmPathFromUmap } from "./ovdrjm-utils";

export type SnapshotKind = "turn" | "pre-rollback";

/** Metadata stored in the `{id}.json` sidecar next to each snapshot. */
export interface SnapshotMeta {
  id: string;
  sessionId: string;
  index: number;
  createdAt: string;
  label?: string;
  kind: SnapshotKind;
}

/** A snapshot on disk: sidecar metadata plus the path to the .ovdrjm copy. */
export interface SnapshotEntry extends SnapshotMeta {
  path: string;
}

export interface CaptureOptions {
  label?: string;
  kind?: SnapshotKind;
}
```

`captureSnapshot`을 다음으로 교체:

```typescript
/**
 * Copy the project's current .ovdrjm into the snapshots dir as
 * `{sessionId}_{index}.ovdrjm` and write a `{sessionId}_{index}.json` metadata
 * sidecar (label, kind, createdAt). Raw byte copy preserves the original
 * UTF-16/UTF-8 encoding. Caller must ensure the level was saved to file first.
 * Returns the snapshot path.
 */
export function captureSnapshot(cwd: string, sessionId: string, index: number, options: CaptureOptions = {}): string {
  const { ovdrjmPath } = resolveOvdrjmPathFromUmap(cwd);
  const dir = snapshotsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const id = `${sessionId}_${index}`;
  const dest = join(dir, `${id}.ovdrjm`);
  copyFileSync(ovdrjmPath, dest);
  const meta: SnapshotMeta = {
    id,
    sessionId,
    index,
    createdAt: new Date().toISOString(),
    ...(options.label !== undefined ? { label: options.label } : {}),
    kind: options.kind ?? "turn",
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta));
  return dest;
}
```

그 아래에 추가:

```typescript
/** Parse `{sessionId}_{index}` from a snapshot filename; sessionId may itself contain underscores. */
function parseSnapshotName(name: string): { sessionId: string; index: number } | undefined {
  const stem = name.slice(0, -".ovdrjm".length);
  const sep = stem.lastIndexOf("_");
  if (sep <= 0) return undefined;
  const index = Number(stem.slice(sep + 1));
  if (!Number.isInteger(index)) return undefined;
  return { sessionId: stem.slice(0, sep), index };
}

/**
 * All snapshots in the project, newest first (by file mtime). Snapshots
 * predating the metadata sidecar are listed with kind "turn", no label, and an
 * mtime-derived createdAt so old projects keep working.
 */
export function listSnapshots(cwd: string): SnapshotEntry[] {
  const dir = snapshotsDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: Array<SnapshotEntry & { mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".ovdrjm")) continue;
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const path = join(dir, name);
    const mtimeMs = statSync(path).mtimeMs;
    const id = name.slice(0, -".ovdrjm".length);
    let meta: SnapshotMeta | undefined;
    try {
      meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8")) as SnapshotMeta;
    } catch {
      // legacy snapshot without metadata sidecar
    }
    entries.push({
      id,
      path,
      sessionId: parsed.sessionId,
      index: parsed.index,
      createdAt: meta?.createdAt ?? new Date(mtimeMs).toISOString(),
      ...(meta?.label !== undefined ? { label: meta.label } : {}),
      kind: meta?.kind ?? "turn",
      mtimeMs,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: PASS (기존 테스트도 전부 — `captureSnapshot`의 반환값과 복사 동작은 불변).

- [ ] **Step 5: 커밋**

```bash
git add src/tools/studiorpc/tools/snapshot.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): add snapshot metadata sidecar and listSnapshots"
```

---

### Task 2: kind 인지 `findLatestSnapshot` + `findSnapshotById`

**파일:**
- 수정: `src/tools/studiorpc/tools/snapshot.ts`
- 테스트: `test/tools/studiorpc-rollback.test.ts`

**인터페이스:**
- 소비: Task 1의 `listSnapshots(cwd)`.
- 생산:

```typescript
export function findLatestSnapshot(cwd: string): SnapshotEntry; // newest with kind !== "pre-rollback"; throws if none
export function findSnapshotById(cwd: string, id: string): SnapshotEntry; // throws if missing
```

`findLatestSnapshot`의 반환 타입이 `{ id, path }`에서 `SnapshotEntry`로 넓어진다 — 상위집합이므로 기존 호출자/테스트는 그대로 동작.

- [ ] **Step 1: 실패하는 테스트 작성**

기존 `describe("findLatestSnapshot", ...)` 블록과 새 블록에 추가:

```typescript
// Inside describe("findLatestSnapshot", ...):
  test("skips pre-rollback snapshots so repeated default rollback stays idempotent", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "edit" });
    captureSnapshot(cwd, "sess", 1, { kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    expect(findLatestSnapshot(cwd).id).toBe("sess_0"); // newest non-pre-rollback
  });

// New top-level describe:
describe("findSnapshotById", () => {
  test("returns the entry for an existing id", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "edit" });
    const entry = findSnapshotById(cwd, "sess_0");
    expect(entry.id).toBe("sess_0");
    expect(entry.path).toBe(join(snapshotsDir(cwd), "sess_0.ovdrjm"));
  });

  test("throws with a helpful message for an unknown id", () => {
    const cwd = projectDir();
    expect(() => findSnapshotById(cwd, "nope_9")).toThrow(/not found/);
  });
});
```

테스트 파일의 snapshot import에 `findSnapshotById`를 추가한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: FAIL — `findSnapshotById` 미export; skip-pre-rollback 테스트가 `sess_1`을 선택함.

- [ ] **Step 3: 구현**

`snapshot.ts`의 `findLatestSnapshot`을 다음으로 교체:

```typescript
/**
 * Most recent restorable snapshot: the newest entry whose kind is not
 * "pre-rollback". Pre-rollback safety snapshots are excluded so a
 * parameterless rollback stays idempotent (calling it twice restores the same
 * baseline instead of undoing itself); they remain reachable via
 * findSnapshotById. Throws if no snapshot exists.
 */
export function findLatestSnapshot(cwd: string): SnapshotEntry {
  const latest = listSnapshots(cwd).find((entry) => entry.kind !== "pre-rollback");
  if (!latest) {
    throw new Error("No rollback snapshot found. Nothing to roll back.");
  }
  return latest;
}

/** Snapshot with the given id. Throws when it does not exist. */
export function findSnapshotById(cwd: string, id: string): SnapshotEntry {
  const entry = listSnapshots(cwd).find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Snapshot "${id}" not found. Use studiorpc_snapshot_list to see available snapshots.`);
  }
  return entry;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: PASS. 기존 테스트 "picks the most recently modified snapshot"은 사이드카 없이 bare `.ovdrjm` 파일을 쓰는데 — 레거시 폴백으로 kind "turn"이 되어 그대로 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add src/tools/studiorpc/tools/snapshot.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): targeted snapshot lookup and pre-rollback-aware latest"
```

---

### Task 3: 스냅샷 정리(prune)

**파일:**
- 수정: `src/tools/studiorpc/tools/snapshot.ts`
- 테스트: `test/tools/studiorpc-rollback.test.ts`

**인터페이스:**
- 생산:

```typescript
export const MAX_SNAPSHOTS_PER_SESSION = 20;
export function pruneSnapshots(cwd: string, sessionId: string, keep?: number): void;
```

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
describe("pruneSnapshots", () => {
  test("keeps only the newest N snapshots for the session, removing files and sidecars", () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0);
    captureSnapshot(cwd, "sess", 1);
    captureSnapshot(cwd, "sess", 2);
    captureSnapshot(cwd, "other", 0); // different session untouched

    pruneSnapshots(cwd, "sess", 2);

    const dir = snapshotsDir(cwd);
    expect(existsSync(join(dir, "sess_0.ovdrjm"))).toBe(false);
    expect(existsSync(join(dir, "sess_0.json"))).toBe(false);
    expect(existsSync(join(dir, "sess_1.ovdrjm"))).toBe(true);
    expect(existsSync(join(dir, "sess_2.ovdrjm"))).toBe(true);
    expect(existsSync(join(dir, "other_0.ovdrjm"))).toBe(true);
  });

  test("is a no-op when under the cap or when the dir does not exist", () => {
    const cwd = projectDir();
    expect(() => pruneSnapshots(cwd, "sess", 2)).not.toThrow(); // no dir yet
    captureSnapshot(cwd, "sess", 0);
    pruneSnapshots(cwd, "sess", 2);
    expect(existsSync(join(snapshotsDir(cwd), "sess_0.ovdrjm"))).toBe(true);
  });
});
```

테스트 파일의 snapshot import에 `pruneSnapshots`를 추가한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: FAIL — "pruneSnapshots is not exported".

- [ ] **Step 3: 구현**

`snapshot.ts`의 `node:fs` import에 `rmSync`를 추가한 뒤 다음을 덧붙인다:

```typescript
// ponytail: fixed cap; make configurable only if a real project needs it.
export const MAX_SNAPSHOTS_PER_SESSION = 20;

/**
 * Delete the oldest snapshots (and their metadata sidecars) beyond `keep` for
 * one session. Ordered by index — within a session the index is monotonic, so
 * it is a more reliable age signal than mtime.
 */
export function pruneSnapshots(cwd: string, sessionId: string, keep = MAX_SNAPSHOTS_PER_SESSION): void {
  const dir = snapshotsDir(cwd);
  const sessionEntries = listSnapshots(cwd)
    .filter((entry) => entry.sessionId === sessionId)
    .sort((a, b) => b.index - a.index);
  for (const entry of sessionEntries.slice(keep)) {
    rmSync(entry.path, { force: true });
    rmSync(join(dir, `${entry.id}.json`), { force: true });
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/tools/studiorpc/tools/snapshot.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): prune rollback snapshots to a per-session cap"
```

---

### Task 4: `index.ts`의 프롬프트 라벨 + 캡처 실패 가시화

**파일:**
- 수정: `src/tools/studiorpc/index.ts`
- 테스트: `test/tools/studiorpc-rollback.test.ts`

**인터페이스:**
- 소비: Task 1/3의 `captureSnapshot(cwd, sessionId, index, { label, kind })`, `pruneSnapshots(cwd, sessionId)`; `UserPromptSubmit` 훅 입력의 `input.prompt`(string).
- 생산: `TurnSnapshotState`에 `promptLabel?: string`, `captureError?: string` 추가. `ensureSnapshot(): string | undefined` (캡처 실패 시 1회성 경고 메시지 반환). 래핑된 편집 툴이 그 경고를 출력 앞에 붙임.

- [ ] **Step 1: 실패하는 테스트 작성**

기존 `describe("snapshot capture on first edit", ...)` 블록 안에 추가 (`hookInput`/`setup`/`importArgs` 헬퍼가 이미 있으니 재사용; `hookInput`은 이미 `prompt: "go"`를 전달함):

```typescript
  test("stores the user prompt as the snapshot label", async () => {
    const cwd = projectDir();
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    await importTool.execute(importArgs as never, toolCtx());

    const meta = JSON.parse(readFileSync(join(snapshotsDir(cwd), "sess_0.json"), "utf-8"));
    expect(meta.label).toBe("go");
    expect(meta.kind).toBe("turn");
  });

  test("surfaces a warning in the tool output when baseline capture fails", async () => {
    // A cwd with a umap but no ovdrjm makes resolveOvdrjmPathFromUmap throw,
    // so captureSnapshot fails while the RPC tool itself still succeeds.
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, "world.umap"), "umap");
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    const first = await importTool.execute(importArgs as never, toolCtx());
    expect(first.output).toContain("[warning] Rollback baseline could not be captured");

    // Reported once per turn, not on every subsequent edit.
    const second = await importTool.execute(importArgs as never, toolCtx());
    expect(second.output).not.toContain("[warning]");
  });

  test("prunes old snapshots after capturing", async () => {
    const cwd = projectDir();
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    // Pre-existing snapshots 0..20 for this session (21 files, cap is 20).
    for (let i = 0; i <= 20; i++) writeFileSync(join(dir, `sess_${i}.ovdrjm`), "{}");
    const { tools } = await setup(cwd, "sess");
    const importTool = tools.find((t) => t.name === "studiorpc_asset_drawer_import")!;

    await importTool.execute(importArgs as never, toolCtx()); // captures sess_21

    expect(existsSync(join(dir, "sess_21.ovdrjm"))).toBe(true);
    expect(existsSync(join(dir, "sess_0.ovdrjm"))).toBe(false); // pruned
    expect(existsSync(join(dir, "sess_1.ovdrjm"))).toBe(false); // pruned (22 - 20 = 2 oldest)
    expect(existsSync(join(dir, "sess_2.ovdrjm"))).toBe(true);
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: FAIL — 메타데이터에 라벨 없음, 출력에 경고 없음, prune 없음.

- [ ] **Step 3: `index.ts` 구현**

`./tools/snapshot` import 갱신:

```typescript
import { captureSnapshot, nextRequestIndex, pruneSnapshots, snapshotsDir } from "./tools/snapshot";
```

상태 인터페이스 확장:

```typescript
/** Per-turn rollback-snapshot state shared between the provider hooks and tools. */
interface TurnSnapshotState {
  sessionId: string | undefined;
  taken: boolean;
  /** Truncated user prompt; becomes the snapshot's label (its rollback-point summary). */
  promptLabel?: string;
  /** First capture failure this turn; set so the warning is reported only once. */
  captureError?: string;
}
```

`beginTurn` 갱신 (초기화 라인 변경 + 새 필드 2개):

```typescript
  const beginTurn: PluginHookFn = async (input: HookInput) => {
    await callRpc("level.save.file", {});
    turnState.sessionId = input.session_id;
    turnState.taken = false;
    // Store generously (2000 chars); display sites truncate to 120. Keeping the
    // full text local means no transcript lookups are ever needed.
    turnState.promptLabel = typeof input.prompt === "string" ? input.prompt.slice(0, 2000) : undefined;
    turnState.captureError = undefined;
    return { blocked: false };
  };
```

`createStudioRpcTools`의 `ensureSnapshot`과 `withSnapshot` 교체:

```typescript
  // Capture the pre-edit rollback baseline once per turn, lazily on the first
  // map-editing tool. On failure, returns a one-time warning for the wrapping
  // tool to surface — a silently missing baseline would make a later rollback
  // restore an older snapshot than the user expects.
  const ensureSnapshot = (): string | undefined => {
    const ts = ctx.turnState;
    if (!ts || ts.taken || !ts.sessionId) return undefined;
    try {
      const index = nextRequestIndex(snapshotsDir(ctx.cwd), ts.sessionId);
      captureSnapshot(ctx.cwd, ts.sessionId, index, { label: ts.promptLabel, kind: "turn" });
      pruneSnapshots(ctx.cwd, ts.sessionId);
      ts.taken = true;
      return undefined;
    } catch (error) {
      if (ts.captureError) return undefined; // already reported this turn
      ts.captureError = (error as Error).message;
      return (
        `[warning] Rollback baseline could not be captured (${ts.captureError}). ` +
        `studiorpc_rollback would restore an older snapshot; check studiorpc_snapshot_list before rolling back.`
      );
    }
  };
  // Wrap a map-editing tool so it snapshots the baseline before it runs and
  // surfaces a capture failure in its output.
  const withSnapshot = (tool: Tool): Tool => ({
    ...tool,
    execute: async (args, toolCtx) => {
      const warning = ensureSnapshot();
      const result = await tool.execute(args, toolCtx);
      return warning ? { ...result, output: `${warning}\n${result.output}` } : result;
    },
  });
```

raw RPC 툴 루프에서 캡처 라인과 성공 반환을 경고 전달로 변경:

```typescript
      async execute(args, toolCtx) {
        const warning = capturesBeforeRun ? ensureSnapshot() : undefined;
        // ... (approval, lock, callRpc, postProcess, save — unchanged) ...
          return {
            output: warning ? `${warning}\n${output}` : output,
            render,
            metadata: { method: rpcMethod, result },
          };
```

(`const warning = ...` 라인이 `if (capturesBeforeRun) ensureSnapshot();`을 대체하고 `output:` 필드에 접두어가 붙는 것만 변경 — 루프의 나머지는 그대로.)

- [ ] **Step 4: 테스트가 통과하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: PASS, 기존 캡처 테스트 전부 포함.

- [ ] **Step 5: 커밋**

```bash
git add src/tools/studiorpc/index.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): label snapshots with the user prompt and surface capture failures"
```

---

### Task 5: `studiorpc_snapshot_list` 툴

**파일:**
- 생성: `src/tools/studiorpc/tools/snapshot-list-tool.ts`
- 수정: `src/tools/studiorpc/index.ts` (툴 등록)
- 테스트: `test/tools/studiorpc-rollback.test.ts`

**인터페이스:**
- 소비: `listSnapshots(cwd)` (Task 1).
- 생산: `{ id, sessionId, index, createdAt, label?, kind }` JSON 배열(path 제외)을 최신순으로 반환하는 읽기 전용 툴 `studiorpc_snapshot_list`. 팩토리: `createSnapshotListTool(cwd: string): Tool`.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
describe("createSnapshotListTool", () => {
  test("lists snapshots newest-first without exposing paths", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "first edit" });
    captureSnapshot(cwd, "sess", 1, { label: "state before rollback", kind: "pre-rollback" });
    const dir = snapshotsDir(cwd);
    utimesSync(join(dir, "sess_0.ovdrjm"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(join(dir, "sess_1.ovdrjm"), new Date(2020, 0, 2), new Date(2020, 0, 2));

    const tool = createSnapshotListTool(cwd);
    const result = await tool.execute({} as never, toolCtx());

    const entries = JSON.parse(result.output);
    expect(entries.map((e: { id: string }) => e.id)).toEqual(["sess_1", "sess_0"]);
    expect(entries[0].kind).toBe("pre-rollback");
    expect(entries[0].path).toBeUndefined();
    expect(result.metadata?.count).toBe(2);
  });

  test("reports when no snapshots exist", async () => {
    const cwd = projectDir();
    const tool = createSnapshotListTool(cwd);
    const result = await tool.execute({} as never, toolCtx());
    expect(result.output).toBe("No snapshots found.");
  });

  test("is registered as a tool on the provider", async () => {
    const provider = createStudioRpcToolProvider({ callRpc: async () => ({}) });
    const tools = await provider.createTools({ cwd: "/tmp/project", host: { approve: async () => "once" } });
    expect(tools.map((tool) => tool.name)).toContain("studiorpc_snapshot_list");
  });
});
```

테스트 파일에 `import { createSnapshotListTool } from "../../src/tools/studiorpc/tools/snapshot-list-tool";`를 추가한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: FAIL — 모듈이 존재하지 않음.

- [ ] **Step 3: `snapshot.ts`에 표시용 헬퍼 추가 후 `snapshot-list-tool.ts` 생성**

`snapshot.ts`에 다음을 덧붙인다 (라벨은 프롬프트 전문을 저장하므로 사람에게 보이는 출력은 압축한다 — Task 6의 롤백 툴도 재사용):

```typescript
/** Labels store the full prompt (up to 2000 chars); keep human-facing output compact. */
export function truncateLabel(label: string): string {
  return label.length > 120 ? `${label.slice(0, 120)}…` : label;
}
```

그다음 `snapshot-list-tool.ts` 생성:

```typescript
// @summary Lists rollback snapshots with labels so a specific restore point can be chosen.

import { z } from "zod";
import type { Tool, ToolResult } from "../types";
import { listSnapshots, truncateLabel } from "./snapshot";

const params = z.object({});

const description =
  "List rollback snapshots for this Studio project, newest first. Each entry has an id (pass it to " +
  "studiorpc_rollback's snapshotId), a label (the user request captured with it), createdAt, and kind. " +
  "'turn' snapshots hold the map state right BEFORE the labeled request ran — restoring one undoes that " +
  "request and everything after it. To return to the state right AFTER a request completed, restore the " +
  "snapshot of the NEXT editing request instead. 'pre-rollback' is the state saved just before a rollback " +
  "ran — restore it to undo that rollback.";

export function createSnapshotListTool(cwd: string): Tool {
  return {
    name: "studiorpc_snapshot_list",
    description,
    parameters: params,
    async execute(): Promise<ToolResult> {
      const entries = listSnapshots(cwd).map(({ path: _path, ...entry }) => ({
        ...entry,
        ...(entry.label !== undefined ? { label: truncateLabel(entry.label) } : {}),
      }));
      return {
        output: entries.length > 0 ? JSON.stringify(entries, null, 2) : "No snapshots found.",
        metadata: { method: "snapshot.list", count: entries.length },
      };
    },
  };
}
```

- [ ] **Step 4: `index.ts`에 등록**

import 추가 (형제들과 알파벳 순):

```typescript
import { createSnapshotListTool } from "./tools/snapshot-list-tool";
```

`tools` 배열에서 rollback 툴 라인 바로 다음에 추가 (읽기 전용, 표준 래퍼 외 별도 승인 불필요):

```typescript
    wrapTool(createRollbackTool(ctx.cwd, callRpc), ctx.host),
    wrapTool(createSnapshotListTool(ctx.cwd), ctx.host),
```

- [ ] **Step 5: 테스트가 통과하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/tools/studiorpc/tools/snapshot-list-tool.ts src/tools/studiorpc/index.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): add snapshot list tool for point-in-time rollback"
```

---

### Task 6: 롤백 툴 — 타겟 복원, 안전 스냅샷, apply 실패 복구

**파일:**
- 수정: `src/tools/studiorpc/tools/rollback-tool.ts` (아래 전체 재작성)
- 테스트: `test/tools/studiorpc-rollback.test.ts` (새 테스트 + 기존 테스트 1개의 단언 변경)

**인터페이스:**
- 소비: `findLatestSnapshot`, `findSnapshotById`, `captureSnapshot`, `restoreSnapshot`, `nextRequestIndex`, `snapshotsDir`, `SnapshotEntry` (Task 1–3).
- 생산: `studiorpc_rollback`이 optional `{ snapshotId: string }`을 받음. 동작 계약:
  1. 대상을 먼저 결정: `snapshotId` 지정 시 `findSnapshotById`; 아니면 `findLatestSnapshot` (`pre-rollback` kind는 건너뜀). 알 수 없는 id → 승인이나 RPC 전에 에러 결과 반환.
  2. 승인 — 프롬프트에 대상 id와 잘린 라벨을 표시해 사용자가 무엇이 복원되는지 알 수 있게 함 → 거절 시 에러 결과 반환.
  3. `level.save.file` (플러시 — 이후 디스크의 ovdrjm이 곧 롤백 직전 상태).
  4. 플러시된 현재 상태를 `pre-rollback` 안전 스냅샷으로 캡처 (best-effort; 라벨 "state before rollback"). 이것이 롤백 자체를 취소 가능하게 만드는 장치.
  5. `restoreSnapshot(target)` → `level.apply`. apply가 throw하면: 안전 사본을 ovdrjm 위에 되돌려(디스크와 에디터가 다시 일치 → 턴 종료 save가 반쯤 적용된 롤백을 조용히 덮어쓸 수 없음) 에러 결과 반환.
  6. `level.save.file` (영속화) → 복원된 id/label/createdAt과 "그 시점 이후 생성된 인스턴스/스크립트는 더 이상 존재하지 않음" 컨텍스트 노트를 담은 성공 출력.

- [ ] **Step 1: 변경되는 기존 테스트 갱신**

`describe("snapshot capture on first edit", ...)`의 `"the rollback tool does not create a snapshot of the state being rolled back"` 테스트는 롤백 후 `sess_1.ovdrjm`이 존재하지 않음을 단언했다. 안전 스냅샷이 이를 의도적으로 바꾼다. 해당 테스트를 다음으로 교체:

```typescript
  test("the rollback turn leaves no 'turn' snapshot but saves a pre-rollback safety snapshot", async () => {
    const cwd = projectDir(); // current ovdrjm = {"Root":{"x":1}}
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}'); // prior edit's baseline
    const { tools } = await setup(cwd, "sess"); // rollback turn begins
    const rollbackTool = tools.find((t) => t.name === "studiorpc_rollback")!;

    await rollbackTool.execute({} as never, toolCtx());

    // Baseline restored; the discarded state was preserved as a pre-rollback snapshot.
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"original":true}}');
    const safetyMeta = JSON.parse(readFileSync(join(dir, "sess_1.json"), "utf-8"));
    expect(safetyMeta.kind).toBe("pre-rollback");
    expect(readFileSync(join(dir, "sess_1.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
    // A second parameterless rollback still targets sess_0 (idempotent).
    await rollbackTool.execute({} as never, toolCtx());
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"original":true}}');
  });
```

- [ ] **Step 2: 새 실패하는 테스트 작성**

`describe("createRollbackTool", ...)`에 추가:

```typescript
  test("restores a specific snapshot when snapshotId is given", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "first edit" }); // {"Root":{"x":1}}
    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":2}}');
    captureSnapshot(cwd, "sess", 1, { label: "second edit" }); // {"Root":{"x":2}}
    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":3}}');
    const tool = createRollbackTool(cwd, async () => ({}));

    const result = await tool.execute({ snapshotId: "sess_0" } as never, toolCtx());

    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
    expect(result.metadata?.restored).toBe("sess_0");
    expect(result.output).toContain("first edit");
  });

  test("reports an error for an unknown snapshotId without touching the map", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0);
    const calls: string[] = [];
    const tool = createRollbackTool(cwd, async (method) => {
      calls.push(method);
      return {};
    });

    const result = await tool.execute({ snapshotId: "missing_1" } as never, toolCtx());

    expect(result.metadata?.error).toBe(true);
    expect(calls).not.toContain("level.apply");
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
  });

  test("restores the pre-rollback state when level.apply fails", async () => {
    const cwd = projectDir(); // current = {"Root":{"x":1}} — the pre-rollback state
    const dir = snapshotsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess_0.ovdrjm"), '{"Root":{"original":true}}');
    const calls: string[] = [];
    const tool = createRollbackTool(cwd, async (method) => {
      calls.push(method);
      if (method === "level.apply") throw new Error("editor busy");
      return {};
    });

    const result = await tool.execute({} as never, toolCtx());

    expect(result.metadata?.error).toBe(true);
    expect(result.output).toContain("level.apply");
    // Disk was put back to the pre-rollback state, so it matches the editor again
    // and the turn-end save cannot silently clobber a half-applied rollback.
    expect(readFileSync(join(cwd, "world.ovdrjm"), "utf-8")).toBe('{"Root":{"x":1}}');
    expect(calls).toEqual(["level.save.file", "level.apply"]); // no final persist save
  });

  test("success output names the restored point and warns about stale references", async () => {
    const cwd = projectDir();
    captureSnapshot(cwd, "sess", 0, { label: "build a castle" });
    writeFileSync(join(cwd, "world.ovdrjm"), '{"Root":{"x":9}}');
    const tool = createRollbackTool(cwd, async () => ({}));

    const result = await tool.execute({} as never, toolCtx());

    expect(result.output).toContain("sess_0");
    expect(result.output).toContain("build a castle");
    expect(result.output).toContain("no longer exist");
  });
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: FAIL — 빈 zod 스키마가 `snapshotId`를 거부, 안전 스냅샷 없음, apply 실패 미처리.

- [ ] **Step 4: `rollback-tool.ts` 재작성**

```typescript
// @summary Rolls the Studio map back to a snapshot (the last pre-request baseline by default).
import { z } from "zod";
import type { call } from "../rpc";
import type { Tool, ToolContext, ToolResult } from "../types";
import {
  captureSnapshot,
  findLatestSnapshot,
  findSnapshotById,
  nextRequestIndex,
  restoreSnapshot,
  type SnapshotEntry,
  snapshotsDir,
  truncateLabel,
} from "./snapshot";

const params = z.object({
  snapshotId: z
    .string()
    .optional()
    .describe(
      "Snapshot to restore, from studiorpc_snapshot_list. Omit to restore the state right before " +
        "the agent's most recent editing request.",
    ),
});

const description =
  "Roll the Studio map back to a saved snapshot. Without snapshotId, restores the state right before the " +
  "agent's most recent editing request. Deterministic full restore: the entire map is reverted to the " +
  "snapshot, discarding any changes made since (including the user's own edits). The discarded state is " +
  "first saved as a 'pre-rollback' snapshot, so the rollback itself can be undone by restoring that " +
  "snapshot via studiorpc_snapshot_list + snapshotId. If the user's reference to a restore point is " +
  "ambiguous, call studiorpc_snapshot_list and confirm the target with the user before calling this tool.";

function errorResult(message: string): ToolResult {
  return { output: message, metadata: { error: true, method: "rollback" } };
}

/**
 * Restore flow (PRD 4.2, extended): resolve target -> approve (naming the
 * target) -> save (flush editor) -> capture pre-rollback safety snapshot ->
 * overwrite ovdrjm with the target snapshot -> apply (sync editor; on failure,
 * put the safety copy back so disk and editor agree) -> save (persist).
 */
export function createRollbackTool(cwd: string, callRpc: typeof call): Tool {
  return {
    name: "studiorpc_rollback",
    description,
    parameters: params,
    async execute(rawArgs, ctx: ToolContext): Promise<ToolResult> {
      const { snapshotId } = params.parse(rawArgs ?? {});

      // Resolve the target before asking for approval so the prompt can say
      // what will be restored — a bare snapshot id means nothing to the user.
      let target: SnapshotEntry;
      try {
        target = snapshotId ? findSnapshotById(cwd, snapshotId) : findLatestSnapshot(cwd);
      } catch (error) {
        return errorResult((error as Error).message);
      }
      const shortLabel = target.label === undefined ? undefined : truncateLabel(target.label);

      const approval = await ctx.approve({
        permission: "execute",
        toolName: "studiorpc_rollback",
        description: `Roll back the Studio map to snapshot ${target.id}${shortLabel ? ` ("${shortLabel}")` : ""}`,
        details: snapshotId ? { snapshotId } : {},
      });
      if (approval === "reject") {
        return errorResult("[Rejected by user]");
      }

      // Flush the current editor state so the level files are consistent.
      // After this, the on-disk ovdrjm IS the pre-rollback state.
      await callRpc("level.save.file", {});

      // Preserve the state being discarded so this rollback can be undone.
      // Best-effort: without it the rollback still works, just without undo.
      let safetyPath: string | undefined;
      try {
        const index = nextRequestIndex(snapshotsDir(cwd), target.sessionId);
        safetyPath = captureSnapshot(cwd, target.sessionId, index, {
          label: "state before rollback",
          kind: "pre-rollback",
        });
      } catch {
        // not fatal — proceed without undo support
      }

      restoreSnapshot(cwd, target.path);
      try {
        await callRpc("level.apply", {});
      } catch (error) {
        // The editor was not synced. Put the file back to the pre-rollback
        // state so disk and editor agree; otherwise the turn-end save would
        // silently overwrite the restored file with the editor's state.
        if (safetyPath) restoreSnapshot(cwd, safetyPath);
        return errorResult(
          `Rollback failed: level.apply error (${(error as Error).message}). The map was left unchanged; ` +
            `fix the Studio connection and retry.`,
        );
      }
      await callRpc("level.save.file", {});

      const labelNote = shortLabel ? ` ("${shortLabel}")` : "";
      const undoNote = safetyPath
        ? " To undo this rollback, restore the pre-rollback snapshot listed by studiorpc_snapshot_list."
        : "";
      return {
        output:
          `Rolled back to snapshot ${target.id}${labelNote}, captured at ${target.createdAt}. ` +
          `Instances and scripts created after that point no longer exist — re-read the map before ` +
          `referencing them.${undoNote}`,
        metadata: { method: "rollback", restored: target.id },
      };
    },
  };
}
```

설계 노트: 안전 스냅샷은 파일명에 `target.sessionId`를 재사용해, 취소 대상 세션과 함께 그룹핑(및 prune)되게 한다 — 툴은 현재 턴의 세션 id에 접근할 수 없고, 필요하지도 않다. `// ponytail: target session reused; plumb real session id only if per-session scoping ever lands`.

- [ ] **Step 5: 테스트가 통과하는지 확인**

실행: `bun test test/tools/studiorpc-rollback.test.ts`
기대: PASS — 기존 `createRollbackTool` 테스트 포함: "restores the latest snapshot" 테스트의 `calls` 단언은 여전히 `["level.save.file", "level.apply", "level.save.file"]`이고, "no snapshot to roll back to" 테스트는 여전히 `level.apply` 전에 에러를 받는다 (이제는 플러시 save보다도 먼저 — 이 테스트의 유일한 RPC 단언은 `not.toContain("level.apply")`라 그대로 통과).

- [ ] **Step 6: 커밋**

```bash
git add src/tools/studiorpc/tools/rollback-tool.ts test/tools/studiorpc-rollback.test.ts
git commit -m "feat(studiorpc): targeted rollback with pre-rollback safety snapshot and apply-failure recovery"
```

---

### Task 7: 전체 검증 스윕

**파일:**
- 새 코드 없음. 검증 + 문서 참조 확인.

- [ ] **Step 1: 사이드카 테스트 스위트 전체 실행**

실행 (`apps/overdare-ai-agent/sidecar/`에서): `bun test`
기대: PASS, 실패 0. 무관한 기존 실패가 보이면 기록하고, 진행 전에 베이스 브랜치에서도 실패하는지 확인한다.

- [ ] **Step 2: 타입체크**

실행 (리포 루트에서): `bun run typecheck` — 해당 스크립트가 없으면 `bunx tsc --noEmit -p apps/overdare-ai-agent/sidecar` 실행 (`package.json` scripts를 먼저 확인하고 리포 자체 커맨드를 우선한다).
기대: 에러 없음.

- [ ] **Step 3: 롤백 툴에 대한 문서/스킬 참조 확인**

실행: `grep -rn "studiorpc_rollback\|studiorpc_snapshot" apps/overdare-ai-agent/bootstrap docs --include="*.md"`
기존의 파라미터 없는 동작만 서술한 히트가 있으면 (예: `bootstrap/skills/overdare-debug-expert/SKILL.md`), `snapshotId` + `studiorpc_snapshot_list`를 언급하도록 문장을 갱신한다. 동작을 서술하는 히트가 없으면 할 일 없음.

- [ ] **Step 4: 커밋 (Step 3에서 문서를 변경한 경우에만)**

```bash
git add -A apps/overdare-ai-agent/bootstrap docs
git commit -m "docs(studiorpc): document point-in-time rollback and snapshot list tool"
```

---

## 셀프 리뷰 노트

- **스펙 커버리지:** 개선점 1, 2, 3, 4, 5, 7과 브레이크포인트 기능이 각각 태스크에 매핑됨 (커버리지 표 참고); 개선점 6은 사유와 후속 경로를 명시하고 범위에서 제외.
- **타입 일관성:** `SnapshotEntry`/`SnapshotMeta`/`CaptureOptions`/`SnapshotKind`는 Task 1에서 한 번 정의되고 Task 2–6에서 이름 그대로 소비됨; `findLatestSnapshot`의 `SnapshotEntry`로의 확장은 기존 `{ id, path }` 소비자와 하위 호환.
- **동작 호환성:** 사이드카 없는 레거시 스냅샷은 kind `"turn"`으로 목록에 나타남; `findLatestSnapshot`이 `pre-rollback` 항목을 건너뛰므로 파라미터 없는 롤백은 멱등성 유지; 의도적으로 변경된 테스트 1개는 Task 6 Step 1에서 새 불변식을 명시하며 재작성됨.
