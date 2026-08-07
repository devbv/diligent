# @summary Apply the explicit smoke configuration inside Windows Sandbox and run the shared Bun harness.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$exitCode = 1
$credentialTarget = "OverdareLogintoken"
$cancelPath = "C:\studio-smoke-bridge\cancel-requested"
$runnerProcess = $null
$mode = "smoke"

# Start-Process -PassThru with redirected stdio returns a process whose ExitCode reads back as
# $null once it exits, because nothing kept the process handle open. Touching .Handle while the
# process is alive pins it, so the exit code survives. Without this the runner's failure is read
# as an empty exit-code.txt and the host scores a failed smoke run as a pass.
function Start-PinnedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$StdoutLog,
        [Parameter(Mandatory = $true)][string]$StderrLog
    )

    $process = Start-Process `
        -FilePath $FilePath `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog
    $null = $process.Handle
    return $process
}

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

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    foreach ($property in $config.environment.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
    }
    $mode = $config.mode
    Remove-Item -LiteralPath $ConfigPath -Force

    $runner = "C:\studio-smoke-bridge\studio-smoke-runner.exe"
    if ($config.mode -eq "auth-bootstrap") {
        Register-AuthBrowser -BrowserExe $env:OVERDARE_STUDIO_AUTH_BROWSER_EXE
        $stdoutLog = "C:\studio-smoke-bridge\sandbox-runner.stdout.log"
        $stderrLog = "C:\studio-smoke-bridge\sandbox-runner.stderr.log"
        $runnerProcess = Start-PinnedProcess `
            -FilePath $runner `
            -StdoutLog $stdoutLog `
            -StderrLog $stderrLog
        $credentialTool = "C:\studio-smoke-bridge\studio-credential.ps1"
        $capturedCredential = "C:\studio-smoke-bridge\captured-credential.local"

        while ($true) {
            if (Test-Path -LiteralPath $cancelPath -PathType Leaf) {
                throw "Studio authentication bootstrap was cancelled by the host."
            }
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
        $runnerProcess = Start-PinnedProcess `
            -FilePath $runner `
            -StdoutLog "C:\studio-smoke-bridge\sandbox-runner.stdout.log" `
            -StderrLog "C:\studio-smoke-bridge\sandbox-runner.stderr.log"
        while (-not $runnerProcess.HasExited -and -not (Test-Path -LiteralPath $cancelPath -PathType Leaf)) {
            Start-Sleep -Milliseconds 500
        }
        if (Test-Path -LiteralPath $cancelPath -PathType Leaf) {
            & "C:\Windows\System32\taskkill.exe" /PID $runnerProcess.Id /T /F *> $null
            $exitCode = 124
        }
        elseif ($null -eq $runnerProcess.ExitCode) {
            throw "The Studio smoke runner exited without reporting an exit code."
        }
        else {
            $exitCode = $runnerProcess.ExitCode
        }
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
    Set-Content -LiteralPath "C:\studio-smoke-bridge\exit-code.txt" -Value $exitCode -Encoding ASCII
    Start-Sleep -Seconds 2
    if ((Test-Path -LiteralPath $cancelPath -PathType Leaf) -or $mode -ne "auth-bootstrap" -or $exitCode -eq 0) {
        & "C:\Windows\System32\shutdown.exe" /s /t 0 /f
    }
}

exit $exitCode
