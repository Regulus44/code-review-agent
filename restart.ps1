$port = 3210
$p = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
if ($p) {
  foreach ($processId in $p) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  Write-Host "stopped port $port"
}

Set-Location $PSScriptRoot
Start-Process -WindowStyle Hidden node -WorkingDirectory $PSScriptRoot -ArgumentList "--env-file-if-exists=.env", "--import", "tsx", "apps/api/src/server.ts"

Write-Host "started TypeScript API on http://127.0.0.1:$port"
