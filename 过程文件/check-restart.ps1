param()
# Reports whether the running DSH host predates a change that only a restart can apply.
# Output: one compact JSON object on stdout. ASCII only: the caller (Node) owns all wording.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateFile = Join-Path $here 'restart-check.json'
$dshHome = Join-Path $env:USERPROFILE '.dsh'

function Get-Hex([string]$text) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  return ([BitConverter]::ToString($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '')
}

# --- current user-level environment snapshot (names -> value hash only, never the value) ---
$curr = @{}
$envKey = 'HKCU:\Environment'
if (Test-Path $envKey) {
  foreach ($name in (Get-Item $envKey).Property) {
    $val = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($null -eq $val) { continue }
    $curr[$name] = Get-Hex ([string]$val)
  }
}

$prev = $null
if (Test-Path $stateFile) {
  try { $prev = [System.IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $prev = $null }
}

$envChanged = @()
$envChangedAt = 0
if ($null -ne $prev -and $null -ne $prev.envMap) {
  $before = @{}
  foreach ($p in $prev.envMap.PSObject.Properties) { $before[$p.Name] = [string]$p.Value }
  foreach ($k in $curr.Keys) {
    if (-not $before.ContainsKey($k) -or $before[$k] -ne $curr[$k]) { $envChanged += $k }
  }
  if ($envChanged.Count -gt 0) { $envChangedAt = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }
  elseif ($null -ne $prev.envChangedAt) {
    $envChangedAt = [int64]$prev.envChangedAt
    if ($null -ne $prev.envChanged) { $envChanged = @($prev.envChanged) }
  }
}

# --- when did the running DSH host start (prefer the web server, whose environment matters) ---
$dshStart = 0
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'bin\.js' -and $_.CommandLine -notmatch 'subprocess-local' })
$web = @($procs | Where-Object { $_.CommandLine -match 'bin\.js"?\s+(web|--profile\s+web)' })
$pick = $null
if ($web.Count -gt 0) { $pick = $web | Sort-Object CreationDate -Descending | Select-Object -First 1 }
elseif ($procs.Count -gt 0) { $pick = $procs | Sort-Object CreationDate -Descending | Select-Object -First 1 }
if ($pick) { $dshStart = [int64]([DateTimeOffset]$pick.CreationDate).ToUnixTimeMilliseconds() }

# --- profile files that only take effect after a restart ---
# cordis.yml is excluded: DSH rewrites it itself at start-up, so its timestamp always trails dshStart.
$profileChanged = @()
$profileChangedAt = 0
$profiles = Join-Path $dshHome 'profiles'
if (Test-Path $profiles) {
  foreach ($dir in Get-ChildItem -LiteralPath $profiles -Directory -ErrorAction SilentlyContinue) {
    foreach ($f in @('cordis.patch.yml', 'package.json')) {
      $p = Join-Path $dir.FullName $f
      if (-not (Test-Path $p)) { continue }
      $t = [int64]([DateTimeOffset](Get-Item -LiteralPath $p).LastWriteTime).ToUnixTimeMilliseconds()
      if ($dshStart -gt 0 -and $t -gt ($dshStart + 120000)) {
        $profileChanged += ($dir.Name + '/' + $f)
        if ($t -gt $profileChangedAt) { $profileChangedAt = $t }
      }
    }
  }
}

$newState = [ordered]@{
  envMap       = $curr
  envChanged   = $envChanged
  envChangedAt = $envChangedAt
}
try {
  [System.IO.File]::WriteAllText($stateFile, ($newState | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
} catch { }

$out = [ordered]@{
  dshStartMs       = $dshStart
  envChanged       = @($envChanged)
  envChangedAt     = $envChangedAt
  profileChanged   = @($profileChanged)
  profileChangedAt = $profileChangedAt
  firstRun         = ($null -eq $prev)
}
$out | ConvertTo-Json -Compress -Depth 4
