# E2E runner: starts the mock gateway (which also serves index.html) and headless Edge,
# runs node test-browser.js, then tears everything down.
#
# Why one script: under the restricted sandbox the whole process tree of a background job
# is reclaimed when the job ends, and Node's child_process cannot spawn with piped stdio
# (EPERM). So PowerShell owns both processes here and the test talks to them over TCP
# (HTTP + CDP WebSocket) only.
#
# Note: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without a BOM as ANSI,
# which mangles non-ASCII string literals and breaks parsing.
#
# Usage: powershell -ExecutionPolicy Bypass -File run-e2e.ps1
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root '.e2e'
New-Item -ItemType Directory -Force -Path $log | Out-Null

$mock = $null
$edge = $null
try {
  $profile = Join-Path $root '.edge-profile'
  if (Test-Path $profile) { Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue }

  # 1) mock gateway (also serves index.html on /)
  $node = (Get-Command node).Source
  $mock = Start-Process -FilePath $node -ArgumentList ((Join-Path $root 'mock-server.js') + ' 8799') `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $log 'mock.log') -RedirectStandardError (Join-Path $log 'mock.err.log')

  # 2) headless Edge with a remote debugging port
  # Note: do NOT pass --single-process/--in-process-gpu here. They were workarounds for the old
  # sandbox, but in single-process mode DevTools never binds its HTTP port (it only prints the
  # ws:// URL), so /json/version is unreachable and the test cannot attach.
  $crash = Join-Path $log 'crash'
  New-Item -ItemType Directory -Force -Path $crash | Out-Null
  $edgePath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  $edgeArgs = '--headless=new --no-sandbox --disable-breakpad --disable-crash-reporter'
  $edgeArgs += ' --disable-features=Crashpad,CrashpadReporting'
  $edgeArgs += ' --crash-dumps-dir=' + $crash
  $edgeArgs += ' --no-first-run --no-default-browser-check --disable-extensions --mute-audio'
  $edgeArgs += ' --disable-dev-shm-usage --disk-cache-size=1 --window-size=1280,900'
  $edgeArgs += ' --remote-debugging-port=8800'
  $edgeArgs += ' --user-data-dir=' + $profile
  $edgeArgs += ' about:blank'
  $edge = Start-Process -FilePath $edgePath -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $log 'edge.log') -RedirectStandardError (Join-Path $log 'edge.err.log')

  # 3) wait until both endpoints answer
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 400
    $okPage = $false
    $okDbg = $false
    try { $okPage = (Invoke-WebRequest 'http://127.0.0.1:8799/' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
    try { $okDbg = (Invoke-WebRequest 'http://127.0.0.1:8800/json/version' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
    if ($okPage -and $okDbg) { $ready = $true; break }
  }
  if (-not $ready) {
    Write-Output 'NOT READY: mock or Edge failed to start'
    Get-Content (Join-Path $log 'edge.err.log') -ErrorAction SilentlyContinue | Select-Object -First 10
  }

  # 4) run the browser test in the foreground so its output lands in this job log
  & $node (Join-Path $root 'test-browser.js')
  Write-Output ('exit code: ' + $LASTEXITCODE)
} finally {
  foreach ($p in @($mock, $edge)) { if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
  Start-Sleep -Milliseconds 500
}
