# @summary Accept the Studio-owned URL scheme registration dialog during unattended smoke startup.

[CmdletBinding()]
param(
    [ValidateRange(10, 600)]
    [int]$TimeoutSeconds = 180,

    [string]$LogPath = "C:\studio-smoke-bridge\url-scheme-dialog.log"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace OverdareStudioSmoke
{
    public static class UrlSchemeDialog
    {
        private const uint BM_CLICK = 0x00F5;
        private const string Prompt = "Do you want to register custom url scheme?";
        private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr state);

        [DllImport("user32.dll")]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumCount);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);

        private static string ReadText(IntPtr window)
        {
            StringBuilder text = new StringBuilder(512);
            GetWindowText(window, text, text.Capacity);
            return text.ToString();
        }

        private static bool IsStudioWindow(IntPtr window)
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            try
            {
                string processName = Process.GetProcessById((int)processId).ProcessName;
                return String.Equals(processName, "Sandbox", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(processName, "Sandbox-Win64-Shipping", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        public static bool TryClickExactPrompt()
        {
            bool accepted = false;
            EnumWindows(delegate(IntPtr window, IntPtr state)
            {
                if (!IsStudioWindow(window)) return true;
                bool hasPrompt = false;
                IntPtr yesButton = IntPtr.Zero;
                EnumChildWindows(window, delegate(IntPtr child, IntPtr childState)
                {
                    string text = ReadText(child);
                    if (String.Equals(text, Prompt, StringComparison.Ordinal)) hasPrompt = true;
                    else if (String.Equals(text, "Yes", StringComparison.Ordinal)) yesButton = child;
                    return true;
                }, IntPtr.Zero);
                if (!hasPrompt || yesButton == IntPtr.Zero) return true;
                SendMessage(yesButton, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                accepted = true;
                return false;
            }, IntPtr.Zero);
            return accepted;
        }

        public static bool TryActivateOwnedMessageWindow()
        {
            bool activated = false;
            EnumWindows(delegate(IntPtr window, IntPtr state)
            {
                if (!IsStudioWindow(window) || !String.Equals(ReadText(window), "Message", StringComparison.Ordinal))
                    return true;
                activated = SetForegroundWindow(window);
                return !activated;
            }, IntPtr.Zero);
            return activated;
        }
    }
}
"@

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    if ([OverdareStudioSmoke.UrlSchemeDialog]::TryClickExactPrompt()) {
        Set-Content -LiteralPath $LogPath -Value "Accepted the exact Studio URL scheme dialog." -Encoding ASCII
        exit 0
    }
    if ([OverdareStudioSmoke.UrlSchemeDialog]::TryActivateOwnedMessageWindow()) {
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        Set-Content -LiteralPath $LogPath -Value "Accepted the Studio-owned Message window with its default Yes action." -Encoding ASCII
        exit 0
    }
    Start-Sleep -Milliseconds 200
}

Set-Content -LiteralPath $LogPath -Value "The Studio URL scheme dialog did not appear." -Encoding ASCII
exit 0
