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

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    foreach ($property in $config.environment.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
    }

    $runner = "C:\studio-smoke-bridge\studio-smoke-runner.exe"
    if ($config.mode -eq "auth-bootstrap") {
        $stdoutLog = "C:\studio-smoke-bridge\sandbox-runner.stdout.log"
        $stderrLog = "C:\studio-smoke-bridge\sandbox-runner.stderr.log"
        $runnerProcess = Start-Process `
            -FilePath $runner `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog
        $credentialTool = "C:\workspace\diligent\apps\overdare-ai-agent\test\studio-smoke\studio-credential.ps1"
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
    Set-Content -LiteralPath "C:\studio-smoke-bridge\exit-code.txt" -Value $exitCode -Encoding ASCII
    Start-Sleep -Seconds 2
    & "C:\Windows\System32\shutdown.exe" /s /t 0 /f
}

exit $exitCode
