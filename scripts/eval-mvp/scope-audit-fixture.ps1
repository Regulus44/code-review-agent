[CmdletBinding()]
param(
  [string]$RepoRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "code-review-agent-scope-audit-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')"

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & git @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed ($LASTEXITCODE)`n$($output | Out-String)" }
  return @($output)
}

try {
  New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
  Invoke-Git @("-C", $fixtureRoot, "init", "-q", "-b", "main") | Out-Null
  Invoke-Git @("-C", $fixtureRoot, "config", "user.email", "scope-audit@example.invalid") | Out-Null
  Invoke-Git @("-C", $fixtureRoot, "config", "user.name", "Scope Audit Fixture") | Out-Null
  Set-Content -LiteralPath (Join-Path $fixtureRoot "allowed.txt") -Value "base" -NoNewline
  Set-Content -LiteralPath (Join-Path $fixtureRoot "deleted.txt") -Value "delete me" -NoNewline
  Invoke-Git @("-C", $fixtureRoot, "add", "allowed.txt", "deleted.txt") | Out-Null
  Invoke-Git @("-C", $fixtureRoot, "commit", "-q", "-m", "fixture") | Out-Null

  Set-Content -LiteralPath (Join-Path $fixtureRoot "allowed.txt") -Value "changed" -NoNewline
  Remove-Item -LiteralPath (Join-Path $fixtureRoot "deleted.txt")
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot ".agent-artifacts") | Out-Null
  Set-Content -LiteralPath (Join-Path $fixtureRoot ".agent-artifacts\tool.txt") -Value "runtime" -NoNewline
  Set-Content -LiteralPath (Join-Path $fixtureRoot "unexpected.py") -Value "out of scope" -NoNewline

  $cli = Join-Path $RepoRoot "scripts\eval-mvp\scope-audit-cli.ts"
  $firstOutput = & node --import tsx $cli --workspace $fixtureRoot --allowed "allowed.txt,deleted.txt" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Scope audit CLI failed: $($firstOutput | Out-String)" }
  $first = ($firstOutput | Out-String) | ConvertFrom-Json
  if (-not $first.scopeViolation) { throw "Expected unexpected.py to trigger scopeViolation" }
  if ($first.runtimeArtifactFiles -notcontains ".agent-artifacts/tool.txt") { throw "Runtime artifact was not classified" }
  if ($first.deletedFiles -notcontains "deleted.txt") { throw "Deleted file was not classified" }
  if ($first.untrackedCandidateFiles -notcontains "unexpected.py") { throw "Untracked candidate was not classified" }

  Remove-Item -LiteralPath (Join-Path $fixtureRoot "unexpected.py")
  $secondOutput = & node --import tsx $cli --workspace $fixtureRoot --allowed "allowed.txt,deleted.txt" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Scope audit CLI failed after cleanup: $($secondOutput | Out-String)" }
  $second = ($secondOutput | Out-String) | ConvertFrom-Json
  if ($second.scopeViolation) { throw "Expected only declared files and runtime artifacts to pass" }
  if ($second.candidateChangedFiles.Count -ne 2) { throw "Expected exactly two candidate files" }
  Write-Host "Scope audit fixture passed: tracked, deleted, untracked, and runtime artifact paths are classified consistently."
} finally {
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
