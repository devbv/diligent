// @summary Windows PowerShell adapter for constrained playtest window capture and input.

export interface DesktopWindow {
  id: string;
  title: string;
  processName: string;
}

export const PLAYTEST_KEYS = ["W", "A", "S", "D", "SPACE"] as const;
export type PlaytestKey = (typeof PLAYTEST_KEYS)[number];

export type DesktopAction = { type: "click_center" } | { type: "set_keys"; keys: PlaytestKey[]; durationMs: number };

export const MAX_PLAYTEST_ACTION_DURATION_MS = 1_500;
export const MAX_PLAYTEST_TOTAL_DURATION_MS = 5_000;
export const MAX_PLAYTEST_TIMELINE_STEPS = 12;

export const DEFAULT_PLAYTEST_ACTIONS: DesktopAction[] = [
  { type: "click_center" },
  { type: "set_keys", keys: ["W"], durationMs: 500 },
  { type: "set_keys", keys: ["SPACE"], durationMs: 50 },
  { type: "set_keys", keys: [], durationMs: 500 },
];

export interface StudioDesktopAdapter {
  listWindows(match: string, signal: AbortSignal): Promise<DesktopWindow[]>;
  capture(options: { windowId: string; match: string; outputPath: string; signal: AbortSignal }): Promise<void>;
  applyActions(options: {
    windowId: string;
    match: string;
    actions: DesktopAction[];
    signal: AbortSignal;
  }): Promise<void>;
}

export type PowerShellPayload =
  | { operation: "list"; match: string }
  | { operation: "capture"; match: string; windowId: string; outputPath: string }
  | { operation: "input"; match: string; windowId: string; actions: DesktopAction[] };

export interface PowerShellChild {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export type PowerShellSpawn = (
  command: string[],
  options: {
    env: Record<string, string | undefined>;
    stdout: "pipe";
    stderr: "pipe";
  },
) => PowerShellChild;

export type PowerShellRunner = (payload: PowerShellPayload, signal: AbortSignal) => Promise<unknown>;

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$nativeSource = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class DiligentWindowInfo {
    public string id { get; set; }
    public string title { get; set; }
    public string processName { get; set; }
}

public static class DiligentPlaytestNative {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    public static DiligentWindowInfo[] ListWindows() {
        List<DiligentWindowInfo> result = new List<DiligentWindowInfo>();
        EnumWindows(delegate(IntPtr handle, IntPtr ignored) {
            if (!IsWindowVisible(handle)) return true;
            int length = GetWindowTextLength(handle);
            if (length <= 0) return true;
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(handle, title, title.Capacity);
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            string processName = "";
            try {
                processName = Process.GetProcessById((int)processId).ProcessName;
            } catch {
                return true;
            }
            result.Add(new DiligentWindowInfo {
                id = handle.ToInt64().ToString(),
                title = title.ToString(),
                processName = processName
            });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    private static IntPtr RequireWindow(string windowId) {
        long value;
        if (!Int64.TryParse(windowId, out value)) throw new InvalidOperationException("Invalid window id.");
        IntPtr handle = new IntPtr(value);
        if (!IsWindow(handle)) throw new InvalidOperationException("Target window no longer exists.");
        return handle;
    }

    private static void RequireClientBounds(IntPtr handle, out RECT rect, out POINT origin) {
        if (!GetClientRect(handle, out rect)) throw new InvalidOperationException("Could not read client bounds.");
        if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) {
            throw new InvalidOperationException("Target window has an empty client area.");
        }
        origin = new POINT { X = rect.Left, Y = rect.Top };
        if (!ClientToScreen(handle, ref origin)) {
            throw new InvalidOperationException("Could not translate client bounds.");
        }
    }

    public static void Capture(string windowId, string outputPath) {
        IntPtr handle = RequireWindow(windowId);
        RECT rect;
        POINT origin;
        RequireClientBounds(handle, out rect, out origin);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        string directory = Path.GetDirectoryName(outputPath);
        if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (Graphics graphics = Graphics.FromImage(bitmap)) {
                graphics.CopyFromScreen(origin.X, origin.Y, 0, 0, new Size(width, height));
            }
            bitmap.Save(outputPath, ImageFormat.Png);
        }
    }

    public static void Focus(string windowId) {
        IntPtr handle = RequireWindow(windowId);
        ShowWindow(handle, 5);
        if (!SetForegroundWindow(handle)) {
            throw new InvalidOperationException("Could not focus the target window.");
        }
        Thread.Sleep(150);
    }

    private static void Send(INPUT input) {
        INPUT[] inputs = new INPUT[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) {
            throw new InvalidOperationException("SendInput failed.");
        }
    }

    public static void ClickCenter(string windowId) {
        IntPtr handle = RequireWindow(windowId);
        RECT rect;
        POINT origin;
        RequireClientBounds(handle, out rect, out origin);
        int x = origin.X + ((rect.Right - rect.Left) / 2);
        int y = origin.Y + ((rect.Bottom - rect.Top) / 2);
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("Could not position the cursor.");
        INPUT down = new INPUT();
        down.type = INPUT_MOUSE;
        down.U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        Send(down);
        INPUT up = new INPUT();
        up.type = INPUT_MOUSE;
        up.U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        Send(up);
    }

    public static void KeyDown(ushort virtualKey) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = virtualKey;
        Send(input);
    }

    public static void KeyUp(ushort virtualKey) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = virtualKey;
        input.U.ki.dwFlags = KEYEVENTF_KEYUP;
        Send(input);
    }
}
"@
Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies @("System.Drawing", "System")

$payloadText = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:OVERDARE_PLAYTEST_PAYLOAD)
)
$payload = $payloadText | ConvertFrom-Json

function Get-MatchingWindows([string] $match) {
    $needle = if ($null -eq $match) { "" } else { $match }
    return @(
        [DiligentPlaytestNative]::ListWindows() | Where-Object {
            $_.title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.processName.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
    )
}

function Assert-TargetWindow([string] $windowId, [string] $match) {
    $targets = @(Get-MatchingWindows $match | Where-Object { $_.id -eq $windowId })
    if ($targets.Count -ne 1) {
        throw "Target window no longer matches the configured OVERDARE window filter."
    }
}

function Get-PlaytestVirtualKey([string] $key) {
    switch ($key) {
        "W" { return [System.UInt16]0x57 }
        "A" { return [System.UInt16]0x41 }
        "S" { return [System.UInt16]0x53 }
        "D" { return [System.UInt16]0x44 }
        "SPACE" { return [System.UInt16]0x20 }
        default { throw "Unsupported playtest key." }
    }
}

switch ($payload.operation) {
    "list" {
        $windows = @(Get-MatchingWindows ([string] $payload.match))
        $result = @($windows | ForEach-Object {
            @{ id = $_.id; title = $_.title; processName = $_.processName }
        })
        ConvertTo-Json -InputObject $result -Compress
    }
    "capture" {
        Assert-TargetWindow ([string] $payload.windowId) ([string] $payload.match)
        [DiligentPlaytestNative]::Capture([string] $payload.windowId, [string] $payload.outputPath)
        ConvertTo-Json -InputObject @{ ok = $true } -Compress
    }
    "input" {
        Assert-TargetWindow ([string] $payload.windowId) ([string] $payload.match)
        [DiligentPlaytestNative]::Focus([string] $payload.windowId)
        $actions = @($payload.actions)
        if ($actions.Count -lt 2 -or $actions.Count -gt 13 -or $actions[0].type -ne "click_center") {
            throw "Invalid playtest action timeline."
        }
        [DiligentPlaytestNative]::ClickCenter([string] $payload.windowId)

        $heldKeys = @()
        $totalDurationMs = 0
        $sawKey = $false
        try {
            foreach ($action in @($actions | Select-Object -Skip 1)) {
                if ($action.type -ne "set_keys") {
                    throw "Unsupported desktop action."
                }
                $durationMs = [int] $action.durationMs
                if ($durationMs -lt 50 -or $durationMs -gt 1500) {
                    throw "Playtest action duration must be between 50 and 1,500 ms."
                }
                $totalDurationMs += $durationMs
                if ($totalDurationMs -gt 5000) {
                    throw "Playtest action timeline exceeds 5,000 ms."
                }

                $targetKeys = @($action.keys | ForEach-Object { [string] $_ })
                if ($targetKeys.Count -gt 3 -or @($targetKeys | Select-Object -Unique).Count -ne $targetKeys.Count) {
                    throw "Playtest step keys must be unique and contain at most three keys."
                }
                foreach ($key in $targetKeys) {
                    [void](Get-PlaytestVirtualKey $key)
                    $sawKey = $true
                }

                foreach ($key in @($heldKeys)) {
                    if ($targetKeys -notcontains $key) {
                        [DiligentPlaytestNative]::KeyUp((Get-PlaytestVirtualKey $key))
                        $heldKeys = @($heldKeys | Where-Object { $_ -ne $key })
                    }
                }
                foreach ($key in $targetKeys) {
                    if ($heldKeys -notcontains $key) {
                        [DiligentPlaytestNative]::KeyDown((Get-PlaytestVirtualKey $key))
                        $heldKeys += $key
                    }
                }
                Start-Sleep -Milliseconds $durationMs
            }
            if (-not $sawKey) {
                throw "Playtest action timeline must include at least one key."
            }
        } finally {
            foreach ($key in @($heldKeys)) {
                [DiligentPlaytestNative]::KeyUp((Get-PlaytestVirtualKey $key))
            }
        }
        ConvertTo-Json -InputObject @{ ok = $true } -Compress
    }
    default {
        throw "Unsupported playtest desktop operation."
    }
}
`;

function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : Promise.resolve("");
}

const defaultSpawn: PowerShellSpawn = (command, options) =>
  Bun.spawn(command, {
    env: options.env,
    stdout: options.stdout,
    stderr: options.stderr,
  }) as unknown as PowerShellChild;

export function createPowerShellRunner(
  options: { spawn?: PowerShellSpawn; timeoutMs?: number } = {},
): PowerShellRunner {
  const spawn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const encodedScript = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");

  return async (payload, signal) => {
    if (signal.aborted) {
      throw new Error("PowerShell playtest interrupted.");
    }

    const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const child = spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedScript,
      ],
      {
        env: { ...process.env, OVERDARE_PLAYTEST_PAYLOAD: payloadBase64 },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    let rejectGuard: ((error: Error) => void) | undefined;
    const guard = new Promise<never>((_, reject) => {
      rejectGuard = reject;
    });
    const kill = () => {
      try {
        child.kill();
      } catch {
        // The process already exited.
      }
    };
    const onAbort = () => {
      kill();
      rejectGuard?.(new Error("PowerShell playtest interrupted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      kill();
      rejectGuard?.(new Error(`PowerShell playtest timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const completed = Promise.all([readStream(child.stdout), readStream(child.stderr), child.exited]);
    // If timeout/abort wins, keep a handler attached to any later child failure.
    void completed.catch(() => {});

    try {
      const [stdout, stderr, exitCode] = await Promise.race([completed, guard]);
      if (exitCode !== 0) {
        throw new Error(`PowerShell playtest failed (${exitCode}): ${stderr.trim() || "unknown error"}`);
      }
      const text = stdout.trim();
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`PowerShell playtest returned invalid JSON: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

function isDesktopWindow(value: unknown): value is DesktopWindow {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    (typeof value.id === "string" || typeof value.id === "number") &&
    "title" in value &&
    typeof value.title === "string" &&
    "processName" in value &&
    typeof value.processName === "string"
  );
}

function isPlaytestKey(value: unknown): value is PlaytestKey {
  return typeof value === "string" && (PLAYTEST_KEYS as readonly string[]).includes(value);
}

function assertPlaytestActions(actions: DesktopAction[]): void {
  if (actions.length < 2 || actions.length > MAX_PLAYTEST_TIMELINE_STEPS + 1) {
    throw new Error(`Playtest actions must contain click_center plus 1-${MAX_PLAYTEST_TIMELINE_STEPS} steps.`);
  }
  if (actions[0]?.type !== "click_center") {
    throw new Error("Playtest actions must start with exactly one click_center action.");
  }

  let totalDurationMs = 0;
  let sawKey = false;
  for (const [index, action] of actions.entries()) {
    if (index === 0) continue;
    if (action.type !== "set_keys") {
      throw new Error("Only set_keys actions may follow click_center.");
    }
    if (
      !Number.isInteger(action.durationMs) ||
      action.durationMs < 50 ||
      action.durationMs > MAX_PLAYTEST_ACTION_DURATION_MS
    ) {
      throw new Error(`Each playtest step must last 50-${MAX_PLAYTEST_ACTION_DURATION_MS.toLocaleString()} ms.`);
    }
    totalDurationMs += action.durationMs;
    if (totalDurationMs > MAX_PLAYTEST_TOTAL_DURATION_MS) {
      throw new Error(`The playtest action timeline may not exceed 5,000 ms.`);
    }
    if (action.keys.length > 3 || new Set(action.keys).size !== action.keys.length) {
      throw new Error("Playtest step keys must be unique and contain at most three keys.");
    }
    if (!action.keys.every(isPlaytestKey)) {
      throw new Error("Playtest steps support only W, A, S, D, and SPACE.");
    }
    if (action.keys.length > 0) sawKey = true;
  }
  if (!sawKey) {
    throw new Error("The playtest action timeline must include at least one key.");
  }
}

export function createWindowsDesktopAdapter(options: { runner?: PowerShellRunner } = {}): StudioDesktopAdapter {
  const runner = options.runner ?? createPowerShellRunner();
  return {
    async listWindows(match, signal) {
      const result = await runner({ operation: "list", match }, signal);
      if (!Array.isArray(result)) {
        throw new Error("PowerShell window enumeration returned an invalid result.");
      }
      return result
        .filter(isDesktopWindow)
        .map((window) => ({ id: String(window.id), title: window.title, processName: window.processName }))
        .filter((window) => window.title.length > 0);
    },
    async capture({ windowId, match, outputPath, signal }) {
      await runner({ operation: "capture", match, windowId, outputPath }, signal);
    },
    async applyActions({ windowId, match, actions, signal }) {
      assertPlaytestActions(actions);
      await runner({ operation: "input", match, windowId, actions }, signal);
    },
  };
}
