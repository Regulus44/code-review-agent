[CmdletBinding()]
param(
  [string]$DatasetRoot = "D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01",
  [string]$RepoRoot = (Get-Location).Path,
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$taskId = "django__django-16046"
$taskPath = Join-Path $DatasetRoot "public\tasks\$taskId\task.json"
$baseWorkspace = Join-Path $DatasetRoot "runtime\workspaces\$taskId"
$goldPatch = Join-Path $DatasetRoot "private\gold-patches\$taskId.patch"
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "code-review-agent-scope-grader-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')"
$agentWorkspace = Join-Path $fixtureRoot "workspace"
$agentDiff = Join-Path $fixtureRoot "agent.diff"
$scopeAuditPath = Join-Path $fixtureRoot "scope-audit.json"
$agentResultPath = Join-Path $fixtureRoot "result.json"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$WorkingDirectory
  )
  $output = if ($null -eq $WorkingDirectory) { & $FilePath @Arguments 2>&1 } else { Push-Location $WorkingDirectory; try { & $FilePath @Arguments 2>&1 } finally { Pop-Location } }
  if ($LASTEXITCODE -ne 0) { throw "$FilePath $($Arguments -join ' ') failed ($LASTEXITCODE)`n$($output | Out-String)" }
  return @($output)
}

function Write-AgentResult {
  param([Parameter(Mandatory = $true)][bool]$ExpectScopeViolation)
  $audit = Get-Content -LiteralPath $scopeAuditPath -Raw | ConvertFrom-Json
  $diffText = Get-Content -LiteralPath $agentDiff -Raw
  $result = [ordered]@{
    schemaVersion = 1
    taskId = $taskId
    workspace = $agentWorkspace
    provider = "fixture"
    model = "fixture"
    status = "completed"
    turnStatus = "completed"
    diff = [ordered]@{
      path = $agentDiff
      changedFiles = @($audit.allChangedFiles)
      candidateChangedFiles = @($audit.candidateChangedFiles)
      runtimeArtifactFiles = @($audit.runtimeArtifactFiles)
      bytes = [System.Text.Encoding]::UTF8.GetByteCount($diffText)
      scopeViolation = [bool]$audit.scopeViolation
      scopeAuditPath = $scopeAuditPath
    }
    scopeAudit = [ordered]@{
      path = $scopeAuditPath
      scopeViolation = [bool]$audit.scopeViolation
      candidateChangedFiles = @($audit.candidateChangedFiles)
      runtimeArtifactFiles = @($audit.runtimeArtifactFiles)
      violations = @($audit.violations)
    }
  }
  $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $agentResultPath -Encoding utf8
  if ([bool]$audit.scopeViolation -ne $ExpectScopeViolation) { throw "Unexpected fixture audit state" }
}

try {
  New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
  Invoke-Checked -FilePath "git" -Arguments @("-c", "core.longpaths=true", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "--no-local", "--quiet", $baseWorkspace, $agentWorkspace) | Out-Null
  Invoke-Checked -FilePath "git" -Arguments @("config", "core.autocrlf", "false") -WorkingDirectory $agentWorkspace | Out-Null
  Invoke-Checked -FilePath "git" -Arguments @("config", "core.longpaths", "true") -WorkingDirectory $agentWorkspace | Out-Null
  Invoke-Checked -FilePath "git" -Arguments @("reset", "--hard", "--quiet", "HEAD") -WorkingDirectory $agentWorkspace | Out-Null
  Invoke-Checked -FilePath "git" -Arguments @("-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "--all", "--force") -WorkingDirectory $agentWorkspace | Out-Null
  Invoke-Checked -FilePath "git" -Arguments @("apply", "--whitespace=nowarn", $goldPatch) -WorkingDirectory $agentWorkspace | Out-Null
  $agentDiffText = Invoke-Checked -FilePath "git" -Arguments @("-c", "core.longpaths=true", "diff", "--binary") -WorkingDirectory $agentWorkspace
  # Preserve LF line endings in the synthetic diff. Set-Content would rewrite
  # native Git output as CRLF on Windows and make the patch fail to apply.
  [System.IO.File]::WriteAllText($agentDiff, (($agentDiffText -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))

  $task = Get-Content -LiteralPath $taskPath -Raw | ConvertFrom-Json
  $allowed = (@($task.allowedPaths) -join ",")
  $cli = Join-Path $RepoRoot "scripts\eval-mvp\scope-audit-cli.ts"
  Invoke-Checked -FilePath "node" -Arguments @("--import", "tsx", $cli, "--workspace", $agentWorkspace, "--allowed", $allowed, "--output", $scopeAuditPath) | Out-Null
  Write-AgentResult -ExpectScopeViolation:$false
  $goldOutput = Invoke-Checked -FilePath "pwsh" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\eval-mvp\grade-agent-run.ps1"), "-TaskId", $taskId, "-AgentResultPath", $agentResultPath, "-DatasetRoot", $DatasetRoot, "-Python", $Python, "-InstallDependencies") -WorkingDirectory $RepoRoot
  $goldResultPath = @($goldOutput | Where-Object { $_ -match '^Result:' } | ForEach-Object { ($_ -replace '^Result:\s*', '').Trim() })[-1]
  $goldResult = Get-Content -LiteralPath $goldResultPath -Raw | ConvertFrom-Json
  if ($goldResult.status -ne "passed" -or $goldResult.scopeViolation) { throw "Expected clean gold fixture to pass" }

  Set-Content -LiteralPath (Join-Path $agentWorkspace "unexpected.py") -Value "out of scope" -NoNewline
  Invoke-Checked -FilePath "node" -Arguments @("--import", "tsx", $cli, "--workspace", $agentWorkspace, "--allowed", $allowed, "--output", $scopeAuditPath) | Out-Null
  Write-AgentResult -ExpectScopeViolation:$true
  $violationOutput = Invoke-Checked -FilePath "pwsh" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts\eval-mvp\grade-agent-run.ps1"), "-TaskId", $taskId, "-AgentResultPath", $agentResultPath, "-DatasetRoot", $DatasetRoot, "-Python", $Python, "-InstallDependencies") -WorkingDirectory $RepoRoot
  $violationResultPath = @($violationOutput | Where-Object { $_ -match '^Result:' } | ForEach-Object { ($_ -replace '^Result:\s*', '').Trim() })[-1]
  $violationResult = Get-Content -LiteralPath $violationResultPath -Raw | ConvertFrom-Json
  if ($violationResult.status -ne "failed" -or -not $violationResult.scopeViolation) { throw "Expected untracked candidate to fail scope audit" }
  Write-Host "Scope audit Grader fixture passed: clean candidate passes and untracked candidate fails closed."
} finally {
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
