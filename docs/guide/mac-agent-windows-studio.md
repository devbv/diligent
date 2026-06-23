# Local Mac Agent <-> Windows Studio Guide

How to run the agent (sidecar backend + frontend) on a Mac and connect it to an **OVERDARE Studio running on a separate Windows PC**. This runs the dev source directly — no built exe or GitHub release download.

## Why this can be split across two machines

The agent <-> Studio connection is **pure TCP JSON-RPC** (`apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts`, `net.createConnection`). There is no shared filesystem between them, and all Studio file access is handled by the Windows-side Studio over RPC. So putting the agent and Studio on different machines is structurally natural.

```
+------------------- Mac --------------------+        +-------- Windows PC --------+
|  Browser (5174, Vite)                      |        |                            |
|      |                                     |        |                            |
|      +- /rpc(WS) -> sidecar backend(7433)  |        |                            |
|                        |                   |        |                            |
|                        +- TCP -------------+--------+-> OVERDARE Studio          |
|                          (STUDIO_HOST:PORT) |  LAN   |   (listening on STUDIO_PORT)|
+---------------------------------------------+        +----------------------------+
```

### What is stored where

| Item | Location | Base path |
| --- | --- | --- |
| skills, knowledge, sessions, images | **Mac** `<--cwd>/.overdare/` | `--cwd` (relative to cwd) |
| config (`overdare.jsonc`: host/port), `user-id` | **Mac** `~/.overdare/` | HOME |
| Studio project files (level/content originals) | **Windows** | managed by Studio |

> The agent's "brain" (skills, knowledge, conversation history, config) all lives on the **Mac**; only the game content originals are on **Windows**. Put a **Mac path** in `--cwd` (not a Windows path).

---

## Prerequisites

### On the Mac

```bash
bun install
```

- AI provider: connect in the app UI under `Config -> AI connection`, or it is used automatically if credentials are in the keychain / `.env.local`.
- Conversation history is stored in `<cwd>/.overdare/sessions` under `--cwd` (default `process.cwd()`).

### On Windows (this is the real crux)

1. **Studio must listen for RPC on a LAN interface (`0.0.0.0` or its LAN IP).** If it binds only to `127.0.0.1`, the Mac cannot connect -> work around it with an [SSH tunnel](#when-studio-listens-only-on-localhost--ssh-tunnel).
2. **Allow inbound on the Studio RPC port (default 13377) in the firewall.**
3. Find the Windows LAN IP: `ipconfig` -> IPv4 address (e.g. `192.168.0.42`).

### Reachability check (from the Mac)

```bash
nc -vz 192.168.0.42 13377   # Windows IP / Studio port
```

If it connects, OK. Otherwise check the Windows listen binding and firewall first.

---

## Option 1 — run directly with env (fastest)

Specify the Windows host/port via environment variables each time.

```bash
# Terminal 1 — Mac: sidecar backend (7433) + Windows Studio connection
STUDIO_HOST=192.168.0.42 \
STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$PWD"

# Terminal 2 — Mac: frontend (Vite, 5174)
bun run --cwd packages/web dev
```

Browser: **http://localhost:5174**

> WARNING: you must use the **sidecar entrypoint** (`apps/overdare-ai-agent/sidecar/src/server.ts`) for `studiorpc_*` tools to load. `bun run web:dev` (web-only, no Studio tools) does not attach the Studio tools.

Host/port resolution order (`rpc.ts:22-40`):

1. `STUDIO_HOST` / `STUDIO_PORT` environment variables
2. config file `~/.overdare/overdare.jsonc`
3. default `localhost:13377`

If specifying env every time is tedious, write it once in the Mac home:

```jsonc
// ~/.overdare/overdare.jsonc
{ "host": "192.168.0.42", "port": 13377 }
```

---

## Option 2 — symlink bundle skills, then run (skills included, macOS)

Option 1 works, but in dev the bundle skills (`actionsequence`, `tpa`, `ui-generator`, `studio-explorer`, etc.) are not installed automatically. On first run the exe's `init.rs` copies bundle skills into `~/.overdare/skills`, but running the dev source directly skips that step.

Skill discovery order is (1) project `<cwd>/.overdare/skills` -> (2) global `~/.overdare/skills` -> (3) config `skills.paths[]` (`packages/runtime/src/skills/discovery.ts:47-55`). On macOS, **symlink the bundle skills into the global location (2)**. (Being symlinks, edits to the repo skills take effect immediately.)

### 0) Symlink bundle skills/agents (one time)

```bash
# run from the repo root
mkdir -p ~/.overdare/skills ~/.overdare/agents

ln -sfn "$PWD/apps/overdare-ai-agent/bootstrap/skills/"* ~/.overdare/skills/
ln -sfn "$PWD/apps/overdare-ai-agent/bootstrap/agents/"* ~/.overdare/agents/
```

Verify:

```bash
ls -l ~/.overdare/skills/    # OK if actionsequence, tpa, ui-generator ... appear as symlinks
```

### 1) Run sidecar + frontend

```bash
# Terminal 1 — Mac: sidecar backend + Windows Studio connection
STUDIO_HOST=192.168.0.42 \
STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$PWD"

# Terminal 2 — Mac: frontend (Vite, 5174)
bun run --cwd packages/web dev
```

Browser: **http://localhost:5174**

> To undo the symlinks: `rm ~/.overdare/skills/*` removes **only the symlinks** (the original repo files stay). To clear the whole directory: `find ~/.overdare/skills -maxdepth 1 -type l -delete`.

---

## All in one script (recommended)

There is a launcher that performs all the steps from Options 1 & 2 (symlink bundle skills -> ensure permission config -> free 7433/5174 -> run sidecar + Vite together -> tear down both on Ctrl+C) in one go.

By default, put the Studio connection info in `.env.local` once (bun auto-loads it, so both the sidecar and the script read these values):

```bash
# .env.local
STUDIO_HOST=10.40.32.103
# STUDIO_PORT=13377   # omit if the default 13377
```

Then run it with no arguments:

```bash
make dev-cross                 # uses STUDIO_HOST from .env.local
# or
scripts/dev-cross-studio.sh
```

To connect to a different Studio one-off, override via arg/env (this wins over `.env.local`):

```bash
make dev-cross STUDIO_HOST=192.168.0.42 STUDIO_PORT=13377
scripts/dev-cross-studio.sh 192.168.0.42 13377
```

> If Studio is on the **same machine** (local), use **`make dev-agent`** instead of `make dev-cross` — same script, but `STUDIO_HOST` defaults to `localhost` so no argument is needed. (For general local development see [`local-development.md`](./local-development.md).)

> `.env.local` is gitignored (it holds secrets like API keys). Do not commit it.

### To also edit — specify the world directory (mount path)

WARNING — **important limitation**: reads like `level.browse` are pure RPC and work cross-machine with the setup above, but **edit/property tools such as `instance_upsert` / `instance_read` read and write the local `.ovdrjm` file directly** (then `level.apply` RPC makes Studio reload). So to edit, the agent must have filesystem access to **the exact live world file that Studio has open**.

How: share the Windows Studio project folder over SMB, mount it on the Mac, and pass that path.

```bash
# mount path as the 3rd argument
scripts/dev-cross-studio.sh 10.40.32.103 13377 /Volumes/StudioProject

# or in .env.local:  STUDIO_PROJECT_DIR=/Volumes/StudioProject
make dev-cross
```

When set, the sidecar `--cwd` becomes this path so edit tools modify the live world directly. **If unset, cwd=repo so only browse works and editing is not possible.**

> NOTE: **The symlink (skills) and the mount (world file) are separate things.** Easy to confuse, so to be clear:
> - **Mount** = access the Windows Studio **project folder** from the Mac to read/write the live `.ovdrjm` **world file**. `--cwd` is this path.
> - **Symlink** (Option 2 / the script) = link the bundle **skills** (actionsequence, tpa, ui-generator, etc.) into the Mac global `~/.overdare/skills`. Unrelated to cwd (discovery path 2).
>
> The mounted project folder does **not** contain the bundle skills — the exe installs skills into **HOME `~/.overdare/skills`**, not the project (`init.rs` -> `global_storage_dir`). So even when you "mount and edit the world", **skills still come from the symlinked Mac global**. You need both.

#### SMB share + mount + write permission (required for editing)

Editing means **writing** to the mounted `.ovdrjm`. If the mount is read-only it fails with `EACCES: permission denied ... .ovdrjm`. All of the following must hold.

1. **Windows: folder share + write permission** — there are two permission layers and **their intersection (the stricter one)** applies, so open both.
   - **Share permission**: right-click the folder -> Properties -> Sharing -> Advanced Sharing -> Permissions -> grant the account **Change**
   - **NTFS permission**: same window -> Security tab -> Edit -> grant the account **Modify**
   - WARNING: the Windows account you grant must be **the same account you authenticate as when mounting from the Mac**.

2. **Mac: mount** — Finder `Cmd+K` -> `smb://<windows-ip>/<share>` -> log in as a registered user (not guest). It mounts at `/Volumes/<share>`.

3. **After changing permissions, always remount** — SMB caches credentials/permissions at mount time. Changing Windows permissions does not affect an existing connection. To also clear the cache:
   ```bash
   umount /Volumes/<share>
   security delete-internet-password -s <windows-ip>   # remove the Keychain cache
   # then reconnect via Finder Cmd+K
   ```

4. **Verify write access** — the following must succeed for editing to work (the script also checks this at startup):
   ```bash
   touch /Volumes/<share>/.__t && echo "write OK" && rm /Volumes/<share>/.__t
   ```

> The permission bits macOS Finder shows (e.g. `-rwx------`) are synthetic and not reliable. Actual access is decided by the Windows ACL, so judge only by the `touch` test above.
>
> If this is a managed (IT-policy) PC and you cannot get share write access, this approach (editing from the Mac agent) is not possible -> switch to the "run the agent on Windows" alternative below.

> `--cwd` decides **both** the world-file location and the `.overdare` (sessions/knowledge/config) store location. If you pass a mount path, runtime data like sessions accumulates in that folder (= the Windows share, which may be slow over SMB). Only the bundle skills are unaffected, since they load from the global `~/.overdare/skills` (Mac) symlink.
>
> Caveat: over SMB, editing can be unstable due to file locking, latency, and line-ending/encoding differences. If it doesn't work, consider **running the agent on Windows and connecting from the Mac with just a browser (`http://<windows-ip>:5174`)** — the file is always local so editing is stable, though code HMR only runs on the machine where the source lives.

- The bundle skill/agent symlinks are created **only if missing**, so it is safe to rerun (idempotent).
- The permission config (`yolo`) is created in the global `~/.overdare/config.jsonc` **only if missing** (left as-is if it already exists). It lives in the global location because it is loaded regardless of cwd (even a read-only mount) and never attempts to write to the mount.
- Browser: **http://localhost:5174**, quit with a single **Ctrl+C** (backend and frontend go down together).

The script itself is `scripts/dev-cross-studio.sh`. To understand how it works, see the manual steps above.

## No build needed

- **Runtime**: `bun run` executes the TypeScript natively. No exe compile, no release download.
- **Frontend**: in dev Vite serves from source (`bun run --cwd packages/web dev`), so no dist build.
- **Bundle skills**: not a build — just "put them on the discovery path" (the Option 2 symlink).

In dev, **`bun run` (runtime) + a one-time symlink (bootstrap)** replaces what the exe did.

---

## Sanity check (smoke test)

Confirm it booted (Mac):

```bash
lsof -nP -iTCP:7433 -sTCP:LISTEN   # backend
lsof -nP -iTCP:5174 -sTCP:LISTEN   # frontend
```

The backend log shows this when healthy:

```
DILIGENT_PORT=7433
RPC endpoint: ws://localhost:7433/rpc
```

- **Web UI**: http://localhost:5174 -> the chat UI appears and the connection status (top-right) is connected.
- **Studio integration**: ask the agent to do something like `studiorpc_level_browse` and check that the Windows Studio responds. On failure, first check `STUDIO_HOST`/`STUDIO_PORT` and whether Windows is listening.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| UI loads but RPC won't connect | Backend (7433) is not up. The Vite proxy target is fixed at 7433 — set the backend port to 7433 |
| `studiorpc_*` tools not visible | Started with the web-only backend (`web:dev`). Restart with the **sidecar entrypoint** |
| Bundle skills (actionsequence, etc.) not visible | Option 2 symlink not done. Check the symlinks under `~/.overdare/skills` |
| Studio connection timeout | `STUDIO_HOST`/`STUDIO_PORT` wrong, or Windows Studio not listening on that port / firewall blocked |
| `nc -vz` works but only RPC fails | Studio isn't speaking the RPC protocol (another process holds the port). Restart Studio |
| Port conflict (`EADDRINUSE`) | Kill the existing process and rerun: `lsof -ti:7433 \| xargs kill` |
| `EACCES: permission denied ... .ovdrjm` / session save fails | Mount is read-only. Grant [SMB write permission](#smb-share--mount--write-permission-required-for-editing) (share + NTFS) and **remount**. If browse works but only editing fails, this is almost always it |
| Still denied after fixing permissions | SMB credential caching. `umount` + `security delete-internet-password -s <ip>`, then reconnect. Judge by the `touch` test, not Finder's displayed permissions |

### When Studio listens only on localhost — SSH tunnel

If Windows Studio binds only to `127.0.0.1` and LAN access is blocked, tunnel from the Mac:

```bash
# Mac: forward Windows' 13377 to the Mac's 13377
ssh -L 13377:localhost:13377 <windows-user>@192.168.0.42
```

With the tunnel up, point the sidecar at **localhost**:

```bash
STUDIO_HOST=localhost STUDIO_PORT=13377 \
bun run apps/overdare-ai-agent/sidecar/src/server.ts --dev --port=7433 --cwd="$PWD"
```

---

## Alternative — run the agent on Windows (when you can't get SMB write access)

If you cannot get share write permission (company policy, etc.), editing the world from the Mac is impossible. In that case **run the agent on Windows (next to Studio).** The world file is local so permission issues disappear, and it matches the production exe topology. This is really just `local-development.md`'s **Mode B (same-machine sidecar)** done on Windows.

```bash
# Windows (Git Bash / PowerShell), after installing the repo + bun:
bun install

# Studio is local so STUDIO_HOST is not needed (defaults to localhost)
STUDIO_PORT=13377 bun run apps/overdare-ai-agent/sidecar/src/server.ts \
  --dev --port=7433 --cwd="C:/path/to/StudioProject"   # the folder that has the actual .umap (local path)

bun run --cwd packages/web dev
```

- `--cwd` is now a **Windows local path** (`C:/...`). Being local, both read and write work.
- To view from the Mac, open `http://<windows-ip>:5174` in a browser (the frontend is a thin WS client). The Studio 3D result is seen on the Windows screen (or via remote desktop).

### Keeping HMR while coding from the Mac

HMR has to run on the machine where the source lives (here, Windows). To develop from the Mac, **edit the Windows files remotely from the Mac**:

- **VS Code / Cursor Remote-SSH** (recommended): edit Windows files directly from the Mac UI -> on save the Windows local file changes, so Vite/sidecar pick it up via HMR immediately. Port-forward to view `http://localhost:5174` on the Mac.
- **File sync** (Mutagen/Syncthing): an alternative when Remote-SSH isn't available. Two-way sync between the Mac and Windows repo.

---

## Shutdown / cleanup

```bash
lsof -ti:7433 | xargs kill   # backend
lsof -ti:5174 | xargs kill   # frontend
```

---

## Reference (code locations)

- sidecar entrypoint: `apps/overdare-ai-agent/sidecar/src/server.ts`
- Studio RPC (connection, host/port resolution): `apps/overdare-ai-agent/sidecar/src/tools/studiorpc/rpc.ts`, `config.ts`
- bundle skills/agents source: `apps/overdare-ai-agent/bootstrap/skills/`, `bootstrap/agents/`
- skill/agent discovery paths: `packages/runtime/src/skills/discovery.ts`, `agents/discovery.ts`
- exe arg -> env conversion (`--studio-rpc-port` -> `STUDIO_PORT`): `apps/overdare-ai-agent/src/webserver.rs`
- exe bootstrap copy (bundle -> global): `apps/overdare-ai-agent/src/init.rs`
- runtime bundle download: `apps/overdare-ai-agent/src/update.rs`
- Vite proxy config: `packages/web/vite.config.ts`

> For general local development with Studio on the same machine (Mac), see [`local-development.md`](./local-development.md).
