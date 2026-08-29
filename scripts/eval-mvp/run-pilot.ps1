[CmdletBinding()]
param(
  [string]$DatasetRoot = "D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01",
  [string]$Python = "python",
  [ValidateRange(1, 512)]
  [int]$MaxSteps = 32,
  [ValidateRange(1000, 3600000)]
  [int]$TestTimeoutMs = 300000,
  [switch]$InstallDependencies
)

$ErrorActionPreference = "Stop"

function Invoke-Process {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [hashtable]$Environment = @{},
    [int]$TimeoutMs = 0
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
  foreach ($entry in $Environment.GetEnumerator()) { $startInfo.Environment[$entry.Key] = [string]$entry.Value }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Could not start process: $FilePath" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    if ($TimeoutMs -gt 0 -and -not $process.WaitForExit($TimeoutMs)) {
      $timedOut = $true
      try { $process.Kill($true) } catch { }
      $process.WaitForExit()
    } else {
      $process.WaitForExit()
    }
    return [pscustomobject]@{
      exitCode = if ($timedOut) { 124 } else { $process.ExitCode }
      stdout = $stdoutTask.Result
      stderr = $stderrTask.Result
      timedOut = $timedOut
    }
  } finally {
    $process.Dispose()
  }
}

function Remove-Ansi {
  param([Parameter(Mandatory = $true)][string]$Text)
  return $Text -replace "\x1B\[[0-9;?]*[ -/]*[@-~]", ""
}

function Find-ResultPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Output,
    [Parameter(Mandatory = $true)]
    [string]$FallbackRoot,
    [Parameter(Mandatory = $true)]
    [string]$TaskId,
    [Parameter(Mandatory = $true)]
    [string]$FileName
  )

  $cleanOutput = Remove-Ansi -Text $Output
  $match = [regex]::Match($cleanOutput, "(?im)^Result:\s*(.+$([regex]::Escape($FileName)))\s*$")
  if ($match.Success -and (Test-Path -LiteralPath $match.Groups[1].Value.Trim())) { return [System.IO.Path]::GetFullPath($match.Groups[1].Value.Trim()) }
  # A result from another task must never be used as a fallback.  Agent startup
  # failures can still leave a partial run directory, so only search this task.
  $candidateRoots = @((Join-Path $FallbackRoot $TaskId))
  $foundCandidates = @()
  foreach ($candidateRoot in $candidateRoots) {
    if (Test-Path -LiteralPath $candidateRoot) {
      $foundCandidates += @(Get-ChildItem -LiteralPath $candidateRoot -Recurse -Filter $FileName -File -ErrorAction SilentlyContinue)
    }
  }
  $candidates = @($foundCandidates | Sort-Object LastWriteTime -Descending)
  if ($candidates.Count -gt 0) { return $candidates[0].FullName }
  return $null
}

function Get-Percentile {
  param(
    [Parameter(Mandatory = $true)]
    [double[]]$Values,
    [Parameter(Mandatory = $true)]
    [double]$Percentile
  )

  if ($Values.Count -eq 0) { return $null }
  $sorted = @($Values | Sort-Object)
  $index = [math]::Ceiling(($Percentile / 100) * $sorted.Count) - 1
  return [int]$sorted[[math]::Max(0, [math]::Min($sorted.Count - 1, $index))]
}

$repoRoot = (Get-Location).Path
$manifestPath = Join-Path $DatasetRoot "public\manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing manifest: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$taskIds = @($manifest.tasks | ForEach-Object { [string]$_.id })
if ($taskIds.Count -lt 1) { throw "Expected at least one active task" }

$batchRunId = "p1-$(Get-Date -Format 'MMdd-HHmmssfff')"
$resultGroup = $batchRunId
$batchDirectory = Join-Path $DatasetRoot "results\pilot\$batchRunId"
$agentResultsRoot = Join-Path $DatasetRoot "results\$resultGroup"
$summaryPath = Join-Path $batchDirectory "summary.json"
$summaryMarkdownPath = Join-Path $batchDirectory "summary.md"
New-Item -ItemType Directory -Force -Path $batchDirectory | Out-Null

$nodePath = (Get-Command node -ErrorAction Stop).Source
$entries = @()
$batchStartedAt = (Get-Date).ToUniversalTime()

foreach ($taskId in $taskIds) {
  $taskStartedAt = (Get-Date).ToUniversalTime()
  $taskLogDirectory = Join-Path $batchDirectory $taskId
  New-Item -ItemType Directory -Force -Path $taskLogDirectory | Out-Null
  Write-Host "RUN $taskId"

  $agentResultPath = $null
  $graderResultPath = $null
  $agentProcess = $null
  $graderProcess = $null
  $agentResult = $null
  $graderResult = $null
  $batchError = $null
  $childEnvironment = @{
    CODING_AGENT_DATASET_ROOT = $DatasetRoot
    CODING_AGENT_RUN_GROUP = $resultGroup
    CODING_AGENT_RUN_ID_PREFIX = "r"
    EVAL_MVP_MAX_STEPS = [string]$MaxSteps
  }

  try {
    $agentProcess = Invoke-Process -FilePath $nodePath -Arguments @("--env-file-if-exists=.env", "--import", "tsx", "scripts/eval-mvp/run-agent-task.ts", $taskId) -WorkingDirectory $repoRoot -Environment $childEnvironment -TimeoutMs 0
    ($agentProcess.stdout + $agentProcess.stderr) | Set-Content -LiteralPath (Join-Path $taskLogDirectory "agent-run.log") -Encoding utf8
    $agentResultPath = Find-ResultPath -Output ($agentProcess.stdout + $agentProcess.stderr) -FallbackRoot $agentResultsRoot -TaskId $taskId -FileName "result.json"
    if ($null -eq $agentResultPath) { throw "Agent result.json was not produced (exitCode=$($agentProcess.exitCode))" }
    $agentResult = Get-Content -LiteralPath $agentResultPath -Raw | ConvertFrom-Json

    $gradeArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $repoRoot "scripts\eval-mvp\grade-agent-run.ps1"), "-TaskId", $taskId, "-AgentResultPath", $agentResultPath, "-DatasetRoot", $DatasetRoot, "-Python", $Python, "-TestTimeoutMs", [string]$TestTimeoutMs)
    if ($InstallDependencies) { $gradeArgs += "-InstallDependencies" }
    $graderProcess = Invoke-Process -FilePath "pwsh" -Arguments $gradeArgs -WorkingDirectory $repoRoot -TimeoutMs 0
    ($graderProcess.stdout + $graderProcess.stderr) | Set-Content -LiteralPath (Join-Path $taskLogDirectory "grader.log") -Encoding utf8
    $graderResultPath = Find-ResultPath -Output ($graderProcess.stdout + $graderProcess.stderr) -FallbackRoot (Split-Path -Parent $agentResultPath) -TaskId $taskId -FileName "grader-result.json"
    if ($null -eq $graderResultPath) { throw "Grader result was not produced (exitCode=$($graderProcess.exitCode))" }
    $graderResult = Get-Content -LiteralPath $graderResultPath -Raw | ConvertFrom-Json
  } catch {
    $batchError = $_.Exception.Message
  }

  $taskEndedAt = (Get-Date).ToUniversalTime()
  $entries += [ordered]@{
    taskId = $taskId
    startedAt = $taskStartedAt.ToString("o")
    endedAt = $taskEndedAt.ToString("o")
    durationMs = [int]($taskEndedAt - $taskStartedAt).TotalMilliseconds
    agentExitCode = if ($null -eq $agentProcess) { $null } else { $agentProcess.exitCode }
    graderExitCode = if ($null -eq $graderProcess) { $null } else { $graderProcess.exitCode }
    agentResultPath = $agentResultPath
    graderResultPath = $graderResultPath
    agent = $agentResult
    grader = $graderResult
    error = $batchError
  }
  if ($null -eq $batchError) {
    Write-Host "DONE $taskId agent=$($agentResult.status) grader=$($graderResult.status)"
  } else {
    Write-Host "FAILED $taskId $batchError"
  }
}

$batchEndedAt = (Get-Date).ToUniversalTime()
$gradedEntries = @($entries | Where-Object { $null -ne $_.grader })
# Infrastructure and grader failures do not measure the agent.  Safety/scope
# violations remain scorable failures, even when they prevent tests from running.
$scorableEntries = @($gradedEntries | Where-Object {
  $_.grader.failureClass -notin @("infra_error", "grader_failed") -or
  $_.grader.failureClass -in @("scope_violation", "security_violation")
})
$passedEntries = @($scorableEntries | Where-Object { $_.grader.status -eq "passed" })
$turnCompletedEntries = @($entries | Where-Object { $null -ne $_.agent -and $_.agent.turnStatus -eq "completed" })
$securityViolations = @($gradedEntries | Where-Object { $_.grader.securityViolation -eq $true })
$durationValues = @($entries | Where-Object { $_.durationMs -is [int] -or $_.durationMs -is [long] } | ForEach-Object { [double]$_.durationMs })
$toolCallValues = @($entries | Where-Object { $null -ne $_.agent } | ForEach-Object { [double]$_.agent.toolCalls })

$summary = [ordered]@{
  schemaVersion = 1
  batchRunId = $batchRunId
  datasetVersion = "pilot-01"
  provider = if ($entries.Count -gt 0 -and $null -ne $entries[0].agent) { $entries[0].agent.provider } else { "unknown" }
  model = if ($entries.Count -gt 0 -and $null -ne $entries[0].agent) { $entries[0].agent.model } else { "unknown" }
  maxSteps = $MaxSteps
  testTimeoutMs = $TestTimeoutMs
  startedAt = $batchStartedAt.ToString("o")
  endedAt = $batchEndedAt.ToString("o")
  durationMs = [int]($batchEndedAt - $batchStartedAt).TotalMilliseconds
  taskCount = $taskIds.Count
  agentResultCount = @($entries | Where-Object { $null -ne $_.agent }).Count
  gradedTaskCount = $gradedEntries.Count
  scorableTaskCount = $scorableEntries.Count
  resolvedAt1 = if ($scorableEntries.Count -eq 0) { $null } else { [math]::Round($passedEntries.Count / $scorableEntries.Count, 4) }
  regressionFreeRate = if ($scorableEntries.Count -eq 0) { $null } else { [math]::Round(@($scorableEntries | Where-Object { $_.grader.grader.passToPass -eq "passed" }).Count / $scorableEntries.Count, 4) }
  turnCompletionRate = if ($entries.Count -eq 0) { $null } else { [math]::Round($turnCompletedEntries.Count / $entries.Count, 4) }
  securityViolationRate = if ($entries.Count -eq 0) { $null } else { [math]::Round($securityViolations.Count / $entries.Count, 4) }
  timeToResolveMs = [ordered]@{ p50 = Get-Percentile -Values $durationValues -Percentile 50; p90 = Get-Percentile -Values $durationValues -Percentile 90 }
  toolCalls = [ordered]@{ p50 = Get-Percentile -Values $toolCallValues -Percentile 50; p90 = Get-Percentile -Values $toolCallValues -Percentile 90 }
  tasks = $entries
}
$summary | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $summaryPath -Encoding utf8

$markdown = @(
  "# Coding Agent MVP pilot-01",
  "",
  "- Batch: $batchRunId",
  "- Provider/model: $($summary.provider) / $($summary.model)",
  "- maxSteps: $MaxSteps",
  "- Tasks: $($summary.taskCount); graded: $($summary.gradedTaskCount); scorable: $($summary.scorableTaskCount)",
  "- Resolved@1: $($summary.resolvedAt1)",
  "- Regression-free rate: $($summary.regressionFreeRate)",
  "- Turn completion rate: $($summary.turnCompletionRate)",
  "- Security violation rate: $($summary.securityViolationRate)",
  "- Time P50/P90: $($summary.timeToResolveMs.p50) / $($summary.timeToResolveMs.p90) ms",
  "- Tool calls P50/P90: $($summary.toolCalls.p50) / $($summary.toolCalls.p90)",
  "",
  "| Task | Agent | Grader | F2P | P2P | Steps | Tools | Changed files | Failure |",
  "|---|---|---|---|---|---:|---:|---:|---|"
)
foreach ($entry in $entries) {
  $agentStatus = if ($null -eq $entry.agent) { "missing" } else { [string]$entry.agent.status }
  $graderStatus = if ($null -eq $entry.grader) { "missing" } else { [string]$entry.grader.status }
  $f2p = if ($null -eq $entry.grader) { "-" } else { [string]$entry.grader.grader.failToPass }
  $p2p = if ($null -eq $entry.grader) { "-" } else { [string]$entry.grader.grader.passToPass }
  $steps = if ($null -eq $entry.agent) { "-" } else { [string]$entry.agent.steps }
  $tools = if ($null -eq $entry.agent) { "-" } else { [string]$entry.agent.toolCalls }
  $files = if ($null -eq $entry.grader) { "-" } else { [string]@($entry.grader.agentChangedFiles).Count }
  $failure = if ($null -ne $entry.error) { $entry.error } elseif ($null -ne $entry.grader.failureClass) { $entry.grader.failureClass } elseif ($null -ne $entry.agent.failureClass) { $entry.agent.failureClass } else { "-" }
  $markdown += "| $($entry.taskId) | $agentStatus | $graderStatus | $f2p | $p2p | $steps | $tools | $files | $failure |"
}
$markdown | Set-Content -LiteralPath $summaryMarkdownPath -Encoding utf8
Write-Host "Pilot completed: $batchRunId"
Write-Host "Summary: $summaryPath"
