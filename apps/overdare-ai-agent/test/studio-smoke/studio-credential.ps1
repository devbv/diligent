# @summary Import, export, validate, or delete the OVERDARE Studio Windows credential without printing its secret.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Import", "Export", "Validate", "Delete", "Exists")]
    [string]$Action,

    [string]$CredentialFile,

    [switch]$RequireAbsent
)

$ErrorActionPreference = "Stop"
$credentialHeader = "OVERDARE_STUDIO_CREDENTIAL_V1"
$credentialTarget = "OverdareLogintoken"

if (-not ("OverdareStudioSmoke.WinCredential" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace OverdareStudioSmoke
{
    public static class WinCredential
    {
        private const uint CredentialTypeGeneric = 1;
        private const uint CredentialPersistLocalMachine = 2;
        private const int ErrorNotFound = 1168;
        private const string Target = "OverdareLogintoken";

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NativeCredential
        {
            public uint Flags;
            public uint Type;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite(ref NativeCredential credential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        [DllImport("advapi32.dll")]
        private static extern void CredFree(IntPtr credential);

        public static bool Exists()
        {
            IntPtr pointer;
            if (!CredRead(Target, CredentialTypeGeneric, 0, out pointer))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorNotFound) return false;
                throw new Win32Exception(error, "Could not read the OVERDARE Studio credential");
            }
            CredFree(pointer);
            return true;
        }

        public static byte[] ReadBlob()
        {
            IntPtr pointer;
            if (!CredRead(Target, CredentialTypeGeneric, 0, out pointer))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorNotFound) return null;
                throw new Win32Exception(error, "Could not read the OVERDARE Studio credential");
            }

            try
            {
                NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
                byte[] blob = new byte[credential.CredentialBlobSize];
                if (blob.Length > 0) Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
                ValidateBlob(blob);
                return blob;
            }
            finally
            {
                CredFree(pointer);
            }
        }

        public static void ValidateBlob(byte[] blob)
        {
            if (blob == null || blob.Length == 0 || blob.Length % 2 != 0)
                throw new InvalidOperationException("The Studio credential blob is not valid UTF-16LE data");

            string value = Encoding.Unicode.GetString(blob).TrimEnd('\0');
            string[] parts = value.Split('|');
            long savedAt;
            if (parts.Length != 3 || String.IsNullOrWhiteSpace(parts[0]) ||
                String.IsNullOrWhiteSpace(parts[1]) || !Int64.TryParse(parts[2], out savedAt) || savedAt <= 0)
                throw new InvalidOperationException("The Studio credential blob does not match accountId|refreshToken|savedAt");
        }

        public static void WriteBlob(byte[] blob, bool requireAbsent)
        {
            ValidateBlob(blob);
            if (requireAbsent && Exists())
                throw new InvalidOperationException("OverdareLogintoken already exists for this Windows user");

            string value = Encoding.Unicode.GetString(blob).TrimEnd('\0');
            string accountId = value.Split('|')[0];
            IntPtr blobPointer = Marshal.AllocHGlobal(blob.Length);
            try
            {
                Marshal.Copy(blob, 0, blobPointer, blob.Length);
                NativeCredential credential = new NativeCredential();
                credential.Type = CredentialTypeGeneric;
                credential.TargetName = Target;
                credential.CredentialBlobSize = (uint)blob.Length;
                credential.CredentialBlob = blobPointer;
                credential.Persist = CredentialPersistLocalMachine;
                credential.UserName = accountId;
                if (!CredWrite(ref credential, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not write the OVERDARE Studio credential");
            }
            finally
            {
                for (int index = 0; index < blob.Length; index++) Marshal.WriteByte(blobPointer, index, 0);
                Marshal.FreeHGlobal(blobPointer);
            }
        }

        public static void Delete()
        {
            if (CredDelete(Target, CredentialTypeGeneric, 0)) return;
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorNotFound)
                throw new Win32Exception(error, "Could not delete the OVERDARE Studio credential");
        }
    }
}
'@
}

function Read-CredentialFixture {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Studio credential fixture does not exist: $Path"
    }
    $lines = @([System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Path).Path) | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    })
    if ($lines.Count -ne 2 -or $lines[0].Trim() -ne $credentialHeader) {
        throw "Studio credential fixture has an invalid header or line count"
    }
    try {
        $blob = [Convert]::FromBase64String($lines[1].Trim())
    }
    catch {
        throw "Studio credential fixture does not contain valid Base64"
    }
    [OverdareStudioSmoke.WinCredential]::ValidateBlob($blob)
    return $blob
}

function Write-CredentialFixture {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Blob
    )

    $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $content = $credentialHeader + "`r`n" + [Convert]::ToBase64String($Blob) + "`r`n"
    [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($Path), $content, [System.Text.UTF8Encoding]::new($false))
}

switch ($Action) {
    "Exists" {
        if ([OverdareStudioSmoke.WinCredential]::Exists()) { exit 0 }
        exit 3
    }
    "Export" {
        if ([string]::IsNullOrWhiteSpace($CredentialFile)) { throw "Export requires -CredentialFile" }
        $blob = [OverdareStudioSmoke.WinCredential]::ReadBlob()
        if ($null -eq $blob) { exit 3 }
        try {
            Write-CredentialFixture -Path $CredentialFile -Blob $blob
        }
        finally {
            [Array]::Clear($blob, 0, $blob.Length)
        }
    }
    "Import" {
        if ([string]::IsNullOrWhiteSpace($CredentialFile)) { throw "Import requires -CredentialFile" }
        $blob = Read-CredentialFixture -Path $CredentialFile
        try {
            [OverdareStudioSmoke.WinCredential]::WriteBlob($blob, $RequireAbsent.IsPresent)
        }
        finally {
            [Array]::Clear($blob, 0, $blob.Length)
        }
    }
    "Validate" {
        if ([string]::IsNullOrWhiteSpace($CredentialFile)) { throw "Validate requires -CredentialFile" }
        $blob = Read-CredentialFixture -Path $CredentialFile
        [Array]::Clear($blob, 0, $blob.Length)
    }
    "Delete" {
        [OverdareStudioSmoke.WinCredential]::Delete()
    }
}
