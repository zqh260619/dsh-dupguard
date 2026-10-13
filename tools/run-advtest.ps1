# Launch the "advanced-mode test profile" in a CLEAN environment.
#
# Why: the plugin's no-restart settings reader prefers $DSH_PROFILE_DIR/cordis.patch.yml.
# If you start this from a terminal that already belongs to a running DSH session, the
# inherited DSH_PROFILE_DIR / DSH_PROFILE / DSH_SESSION_ID / DSH_WEB_URL point at THAT
# profile, so the plugin would read another profile's settings (measured: thresholdMode
# got overwritten with "table" and the whitelist became the other profile's 9 entries).
# Clearing them makes this profile's own cordis.patch.yml authoritative.
#
# Usage:
#   powershell -File tools\run-advtest.ps1                 # main DSH_HOME + advtest profile
#   powershell -File tools\run-advtest.ps1 -WhatIfOnly     # only show what would be cleared
#   powershell -File tools\run-advtest.ps1 -DshHome D:\ZQH260619\repos\dupguard-advtest-home
#   powershell -File tools\run-advtest.ps1 -Profile advtest
#
# Notes: stdin is closed on purpose, so the interactive TUI exits right after startup.
# That makes this a cheap smoke check of the effective parameters in the host log.
# (-DshHome, not -Home: $HOME is a read-only automatic variable in Windows PowerShell.)
param(
  [string]$Profile = 'advtest',
  [string]$DshHome = '',
  [switch]$WhatIfOnly
)

$inherited = 'DSH_PROFILE_DIR', 'DSH_PROFILE', 'DSH_SESSION_ID', 'DSH_WEB_URL'
$cleared = @()
foreach ($name in $inherited) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) {
    $cleared += ($name + '=' + $value)
    if (-not $WhatIfOnly) { Remove-Item ('env:' + $name) -ErrorAction SilentlyContinue }
  }
}

if ($DshHome -ne '') {
  if (-not (Test-Path $DshHome)) { Write-Error ('DSH_HOME does not exist: ' + $DshHome); exit 1 }
  $env:DSH_HOME = $DshHome
}

$clearedText = if ($cleared.Count -gt 0) { $cleared -join '; ' } else { '(none)' }
Write-Host ('Cleared inherited vars: ' + $clearedText)
Write-Host ('DSH_HOME   = ' + $env:DSH_HOME)
Write-Host ('Launching  : dsh --profile ' + $Profile)
if ($WhatIfOnly) { exit 0 }

$null | dsh --profile $Profile
