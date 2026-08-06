# @summary Apply the explicit smoke configuration inside Windows Sandbox and run the shared Bun harness.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$exitCode = 1
$credentialTarget = "OverdareLogintoken"
$runnerProcess = $null
$urlSchemeDialogAcceptor = $null

function Register-AuthBrowser {
    param([Parameter(Mandatory = $true)][string]$BrowserExe)

    if (-not (Test-Path -LiteralPath $BrowserExe -PathType Leaf)) {
        throw "Mapped authentication browser does not exist: $BrowserExe"
    }
    $profilePath = "C:\studio-auth-browser-profile"
    New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
    $browserCommand = '"{0}" --user-data-dir="{1}" --no-first-run --no-default-browser-check --disable-gpu "%1"' -f `
        $BrowserExe, $profilePath
    foreach ($scheme in @("http", "https")) {
        $schemeKey = "HKCU:\Software\Classes\$scheme"
        $commandKey = Join-Path $schemeKey "shell\open\command"
        New-Item -Path $commandKey -Force | Out-Null
        New-ItemProperty -Path $schemeKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
        Set-Item -Path $commandKey -Value $browserCommand
    }
}

function Register-StagedVcRuntime {
    $runtimeKey = "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    New-Item -Path $runtimeKey -Force | Out-Null
    foreach ($entry in @{
        Installed = 1
        Major = 14
        Minor = 36
        Bld = 32532
        Rbld = 0
    }.GetEnumerator()) {
        New-ItemProperty `
            -Path $runtimeKey `
            -Name $entry.Key `
            -Value $entry.Value `
            -PropertyType DWord `
            -Force | Out-Null
    }
    New-ItemProperty `
        -Path $runtimeKey `
        -Name "Version" `
        -Value "v14.36.32532.00" `
        -PropertyType String `
        -Force | Out-Null
}

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    foreach ($property in $config.environment.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
    }
    Register-StagedVcRuntime

    $urlSchemeDialogAcceptor = Start-Process `
        -FilePath "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList @(
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", "C:\studio-smoke-bridge\accept-studio-url-scheme.ps1"
        ) `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardOutput "C:\studio-smoke-bridge\url-scheme-dialog.stdout.log" `
        -RedirectStandardError "C:\studio-smoke-bridge\url-scheme-dialog.stderr.log"

    $runner = "C:\studio-smoke-bridge\studio-smoke-runner.exe"
    if ($config.mode -eq "auth-bootstrap") {
        Register-AuthBrowser -BrowserExe $env:OVERDARE_STUDIO_AUTH_BROWSER_EXE
        $stdoutLog = "C:\studio-smoke-bridge\sandbox-runner.stdout.log"
        $stderrLog = "C:\studio-smoke-bridge\sandbox-runner.stderr.log"
        $runnerProcess = Start-Process `
            -FilePath $runner `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog
        $credentialTool = "C:\studio-smoke-bridge\studio-credential.ps1"
        $capturedCredential = "C:\studio-smoke-bridge\captured-credential.local"

        while ($true) {
            & "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
                -NoLogo `
                -NoProfile `
                -ExecutionPolicy Bypass `
                -File $credentialTool `
                -Action Export `
                -CredentialFile $capturedCredential *> $null
            if ($LASTEXITCODE -eq 0) {
                $exitCode = 0
                break
            }
            if ($runnerProcess.HasExited) {
                throw "Studio stopped before $credentialTarget was captured. Runner exit code: $($runnerProcess.ExitCode)"
            }
            Start-Sleep -Seconds 2
        }
    }
    else {
        Copy-Item `
            -LiteralPath "C:\studio-smoke-bridge\runtime-input" `
            -Destination "C:\studio-smoke-runtime-input" `
            -Recurse `
            -Force
        & $runner *> "C:\studio-smoke-bridge\sandbox-runner.log"
        $exitCode = $LASTEXITCODE
    }
}
catch {
    $_ | Out-String | Set-Content -LiteralPath "C:\studio-smoke-bridge\sandbox-bootstrap-error.txt" -Encoding UTF8
    $exitCode = 1
}
finally {
    if ($null -ne $runnerProcess -and -not $runnerProcess.HasExited) {
        & "C:\Windows\System32\taskkill.exe" /PID $runnerProcess.Id /T /F *> $null
    }
    if ($null -ne $urlSchemeDialogAcceptor -and -not $urlSchemeDialogAcceptor.HasExited) {
        & "C:\Windows\System32\taskkill.exe" /PID $urlSchemeDialogAcceptor.Id /T /F *> $null
    }
    Set-Content -LiteralPath "C:\studio-smoke-bridge\exit-code.txt" -Value $exitCode -Encoding ASCII
    Start-Sleep -Seconds 2
    if ($config.mode -ne "auth-bootstrap" -or $exitCode -eq 0) {
        & "C:\Windows\System32\shutdown.exe" /s /t 0 /f
    }
}

exit $exitCode
