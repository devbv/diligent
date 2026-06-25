#!/bin/sh
# @summary Patches lefthook-generated git hooks for Git Bash compatibility on Windows.
# Injects LEFTHOOK_BIN using a POSIX path so Git Bash can find lefthook.exe
# without relying on the hardcoded Windows absolute path bun generates.
# Also ensures bun/node are in PATH for hook-invoked commands.

PATCH_MARKER="# git-bash-compat-patch"

patch_hook() {
  hook="$1"
  [ -f "$hook" ] || return 0

  # Skip if already patched
  grep -q "$PATCH_MARKER" "$hook" && return

  # Build the patch block to inject after the shebang line
  PATCH=$(cat <<'PATCH_BLOCK'
# git-bash-compat-patch: ensure lefthook, bun, and node are resolvable in Git Bash
if [ -z "$LEFTHOOK_BIN" ]; then
  _root="$(git rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$_root" ] && [ -f "$_root/node_modules/.bin/lefthook.exe" ]; then
    export LEFTHOOK_BIN="$_root/node_modules/.bin/lefthook.exe"
  fi
  unset _root
fi
# Ensure bun is in PATH (Git Bash may have a stripped-down PATH)
export PATH="$HOME/.bun/bin:$PATH"
# Provide a node shim when only bun is installed
_root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$_root" ] && [ -d "$_root/scripts/shims" ]; then
  export PATH="$_root/scripts/shims:$PATH"
fi
unset _root
PATCH_BLOCK
)

  # Insert patch after the shebang line (line 1)
  # Use a temp file approach compatible with MSYS/Git Bash
  tmpfile="${hook}.tmp"
  {
    head -1 "$hook"
    printf '%s\n' "$PATCH"
    tail -n +2 "$hook"
  } > "$tmpfile" && mv "$tmpfile" "$hook"

  chmod +x "$hook"

  echo "Patched: $hook"
}

patch_hook "$(git rev-parse --git-path hooks/pre-commit 2>/dev/null || printf '%s' .git/hooks/pre-commit)"
patch_hook "$(git rev-parse --git-path hooks/commit-msg 2>/dev/null || printf '%s' .git/hooks/commit-msg)"
patch_hook "$(git rev-parse --git-path hooks/pre-push 2>/dev/null || printf '%s' .git/hooks/pre-push)"
