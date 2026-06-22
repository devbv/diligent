#!/usr/bin/env bash
#
# dev-cross-studio.sh — Mac 로컬 agent ↔ Windows PC Studio 연결 dev 런처.
#
# docs/guide/mac-agent-windows-studio.md 의 절차를 한 번에 수행한다:
#   0. 사이드카 cwd 결정 (월드 마운트 경로 유무 → 편집 가능 여부)
#   1. 번들 스킬/에이전트를 글로벌(~/.overdare)로 심링크 (없을 때만)
#   2. 글로벌 ~/.overdare/config.jsonc 에 yolo 권한 보장 (없을 때만)
#   3. 7433/5174 잔류 프로세스 정리
#   4. 사이드카 백엔드(7433) + 프론트 Vite(5174) 동시 실행
#   5. Ctrl+C 한 번으로 둘 다 종료
#
# 값 우선순위 (공통): CLI 인자 > 기존 환경변수 > .env.local > 기본값
#   $1 / STUDIO_HOST          윈도우 IP (필수)
#   $2 / STUDIO_PORT          Studio RPC 포트 (기본 13377)
#   $3 / STUDIO_PROJECT_DIR   (옵션) Mac에 마운트된 Studio 프로젝트 폴더 경로.
#                             지정 시 사이드카 --cwd 가 이 경로가 되어,
#                             instance_upsert 등 편집 도구가 "라이브 월드 파일"을
#                             직접 읽고/쓴다. 미지정 시 cwd=repo (browse만 가능).
#
# 사용법:
#   scripts/dev-cross-studio.sh                              # .env.local 값 사용
#   scripts/dev-cross-studio.sh <windows-ip> [port] [world-dir]
#
# 예:
#   scripts/dev-cross-studio.sh                              # browse 전용(편집 X)
#   scripts/dev-cross-studio.sh 192.168.0.42 13377 /Volumes/StudioProject
#   # 또는 .env.local 에 STUDIO_PROJECT_DIR=/Volumes/StudioProject 적어두기

set -euo pipefail

# --- 경로 / 인자 -----------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 명시값(인자/기존 env)을 먼저 잡아둔다 — .env.local 보다 우선.
EXPLICIT_HOST="${1:-${STUDIO_HOST:-}}"
EXPLICIT_PORT="${2:-${STUDIO_PORT:-}}"
EXPLICIT_WORLD="${3:-${STUDIO_PROJECT_DIR:-}}"

# .env.local 로드 (있으면). set -a 로 export 하여 자식 프로세스(bun)에도 전달.
ENV_FILE="${REPO_ROOT}/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "▶ .env.local 로드됨"
fi

# 명시값이 있으면 .env.local 값을 덮어쓴다.
STUDIO_HOST="${EXPLICIT_HOST:-${STUDIO_HOST:-}}"
STUDIO_PORT="${EXPLICIT_PORT:-${STUDIO_PORT:-13377}}"
WORLD_DIR="${EXPLICIT_WORLD:-${STUDIO_PROJECT_DIR:-}}"

BACKEND_PORT=7433
FRONTEND_PORT=5174
GLOBAL_DIR="${HOME}/.overdare"
BOOTSTRAP="${REPO_ROOT}/apps/overdare-ai-agent/bootstrap"
SIDECAR="${REPO_ROOT}/apps/overdare-ai-agent/sidecar/src/server.ts"

if [ -z "$STUDIO_HOST" ]; then
  echo "✗ STUDIO_HOST(윈도우 IP)를 찾을 수 없습니다." >&2
  echo "  .env.local 에 STUDIO_HOST=<윈도우-IP> 를 넣거나," >&2
  echo "  인자로 넘기세요: scripts/dev-cross-studio.sh <windows-ip> [studio-port]" >&2
  exit 1
fi

echo "▶ Studio 대상: ${STUDIO_HOST}:${STUDIO_PORT}"

# --- 0. 사이드카 cwd 결정 (월드 파일 위치 = 편집 가능 여부) ------------------
# WORLD_DIR 지정 시: cwd=마운트 경로 → 편집 도구가 라이브 .ovdrjm 를 직접 수정.
# 미지정 시: cwd=repo → level.browse 등 RPC 읽기만 가능, 편집은 불가.
if [ -n "$WORLD_DIR" ]; then
  if [ ! -d "$WORLD_DIR" ]; then
    echo "✗ 월드 디렉터리가 없습니다: ${WORLD_DIR}" >&2
    echo "  Windows Studio 프로젝트 폴더가 Mac에 마운트됐는지 확인하세요." >&2
    exit 1
  fi
  CWD="$WORLD_DIR"
  umap_count="$(find "$WORLD_DIR" -maxdepth 1 -iname '*.umap' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$umap_count" = "1" ]; then
    echo "▶ 월드 디렉터리: ${WORLD_DIR} (.umap 1개 확인)"
  elif [ "$umap_count" = "0" ]; then
    echo "⚠ ${WORLD_DIR} 에 .umap 이 없습니다 — 편집 도구가 월드 파일을 못 찾습니다."
  else
    echo "⚠ ${WORLD_DIR} 에 .umap 이 ${umap_count}개 — 편집 도구는 정확히 1개를 요구합니다."
  fi
  # 쓰기 권한 점검 — 편집(.ovdrjm 쓰기)과 세션 저장에 필수.
  if touch "${WORLD_DIR}/.__diligent_write_test" 2>/dev/null; then
    rm -f "${WORLD_DIR}/.__diligent_write_test"
    echo "  ✓ 마운트 쓰기 가능 — 편집 가능"
  else
    echo "  ⚠ 마운트가 read-only/권한없음 — 편집과 세션 저장이 실패합니다."
    echo "    Windows 공유 설정에서 이 계정에 '쓰기/변경' 권한을 부여하세요."
  fi
else
  CWD="$REPO_ROOT"
  echo "▶ 월드 디렉터리 미지정 → cwd=repo (browse만 가능, 편집 불가)."
  echo "  편집하려면 3번째 인자나 STUDIO_PROJECT_DIR 로 마운트 경로를 주세요."
fi

# --- 1. 번들 스킬/에이전트 심링크 (idempotent) ------------------------------
link_bundle() {
  local kind="$1" # skills | agents
  local src="${BOOTSTRAP}/${kind}"
  local dst="${GLOBAL_DIR}/${kind}"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  local linked=0
  for entry in "$src"/*; do
    [ -e "$entry" ] || continue
    ln -sfn "$entry" "$dst/$(basename "$entry")"
    linked=$((linked + 1))
  done
  echo "  ✓ ${kind}: ${linked}개 심링크 → ${dst}"
}
echo "▶ 번들 스킬/에이전트 심링크"
link_bundle skills
link_bundle agents

# --- 2. yolo 권한 config 보장 (글로벌, 없을 때만) ---------------------------
# 글로벌 ~/.overdare/config.jsonc 에 둔다. 이유:
#   - cwd 가 무엇이든(특히 read-only 마운트여도) 항상 로드됨 (loader: 글로벌+프로젝트 머지).
#   - 마운트에 쓰기를 시도하지 않아 read-only 공유에서도 안전.
GLOBAL_CONFIG="${GLOBAL_DIR}/config.jsonc"
if [ ! -f "$GLOBAL_CONFIG" ]; then
  mkdir -p "$GLOBAL_DIR"
  printf '{\n  // dev 권한 프롬프트 비활성 (exe bootstrap/config.jsonc와 동일)\n  "yolo": true\n}\n' >"$GLOBAL_CONFIG"
  echo "▶ 권한 config 생성: ${GLOBAL_CONFIG} (yolo:true)"
else
  echo "▶ 권한 config: 기존 글로벌 설정 유지 (변경 안 함)"
fi

# --- 3. 잔류 포트 정리 ------------------------------------------------------
free_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "  ✓ 포트 ${port} 점유 프로세스 종료: ${pids}"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -ti:"$port" 2>/dev/null || true)"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
}
echo "▶ 포트 정리 (${BACKEND_PORT}, ${FRONTEND_PORT})"
free_port "$BACKEND_PORT"
free_port "$FRONTEND_PORT"

# --- 4. 도달 확인 (실패해도 진행, 경고만) -----------------------------------
if command -v nc >/dev/null 2>&1; then
  if nc -z -w 2 "$STUDIO_HOST" "$STUDIO_PORT" 2>/dev/null; then
    echo "▶ Studio 도달 확인: OK (${STUDIO_HOST}:${STUDIO_PORT})"
  else
    echo "⚠ Studio(${STUDIO_HOST}:${STUDIO_PORT})에 닿지 않습니다 — Windows 리슨/방화벽 확인. 일단 계속 진행합니다."
  fi
fi

# --- 5. 프로세스 실행 + 종료 트랩 -------------------------------------------
BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
  echo ""
  echo "▶ 종료 정리 중..."
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "  ✓ 종료 완료"
}
trap cleanup EXIT INT TERM

echo "▶ 사이드카 백엔드 시작 (:${BACKEND_PORT}, cwd=${CWD})"
STUDIO_HOST="$STUDIO_HOST" STUDIO_PORT="$STUDIO_PORT" \
  bun run "$SIDECAR" --dev --port="$BACKEND_PORT" --cwd="$CWD" &
BACKEND_PID=$!

echo "▶ 프론트 Vite 시작 (:${FRONTEND_PORT})"
bun run --cwd packages/web dev &
FRONTEND_PID=$!

echo ""
echo "  브라우저: http://localhost:${FRONTEND_PORT}"
echo "  종료: Ctrl+C"
echo ""

# 둘 중 하나라도 죽으면 루프를 빠져나가고, EXIT 트랩이 나머지를 정리한다.
# (macOS 기본 bash 3.2 에는 `wait -n` 이 없어 폴링으로 대기한다.)
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
