[CmdletBinding()]
param(
  [string]$DatasetRoot = "D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01",
  [ValidateRange(1, 512)]
  [int]$MaxConcurrency = 1
)

$ErrorActionPreference = "Stop"

function Start-AgentProcess {
  param([string]$TaskId, [string]$TaskDirectory)
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodePath; $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true; $startInfo.RedirectStandardError = $true
  foreach ($argument in @("--env-file-if-exists=.env", "--import", "tsx", "scripts/eval-mvp/run-agent-task.ts", $TaskId)) { [void]$startInfo.ArgumentList.Add($argument) }
  $startInfo.Environment["CODING_AGENT_DATASET_ROOT"] = $DatasetRoot
  $startInfo.Environment["CODING_AGENT_RUN_GROUP"] = $batchRunId
  $startInfo.Environment["CODING_AGENT_RUN_ID_PREFIX"] = "run"
  $process = [System.Diagnostics.Process]::new(); $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Could not start process: $nodePath" }
    return [pscustomobject]@{
      taskId = $TaskId
      taskDirectory = $TaskDirectory
      process = $process
      stdout = $process.StandardOutput.ReadToEndAsync()
      stderr = $process.StandardError.ReadToEndAsync()
    }
  } catch {
    $process.Dispose()
    throw
  }
}

function Complete-AgentProcess {
  param([pscustomobject]$Invocation)
  $process = $Invocation.process
  $process.WaitForExit()
  $stdout = $Invocation.stdout.Result
  $stderr = $Invocation.stderr.Result
  $output = $stdout + $stderr
  $logPath = Join-Path $Invocation.taskDirectory "agent-run.log"
  $output | Set-Content -LiteralPath $logPath -Encoding utf8
  $resultPath = Find-ResultPath -Output $output -ResultsRoot $agentResultsRoot -TaskId $Invocation.taskId
  $result = if ($null -eq $resultPath) { $null } else { Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json }
  $traceStatus = if ($null -eq $result -or [string]::IsNullOrWhiteSpace([string]$result.traceStatus)) { "missing" } else { [string]$result.traceStatus }
  $boundaryStatus = if ($null -eq $result -or [string]::IsNullOrWhiteSpace([string]$result.boundaryStatus)) { "unknown" } else { [string]$result.boundaryStatus }
  $evaluationStatus = if ($null -eq $result -or $traceStatus -ne "complete") { "invalid_trace" } elseif ($boundaryStatus -eq "contaminated") { "contaminated" } elseif ([string]::IsNullOrWhiteSpace([string]$result.evaluationStatus)) { [string]$result.status } else { [string]$result.evaluationStatus }
  $guardDenialCount = if ($null -eq $result -or $null -eq $result.trace) { 0 } else { @($result.trace.guardDenials).Count }
  $entry = [ordered]@{ taskId = $Invocation.taskId; exitCode = $process.ExitCode; resultPath = $resultPath; logPath = $logPath; evaluationStatus = $evaluationStatus; traceStatus = $traceStatus; boundaryStatus = $boundaryStatus; guardDenialCount = $guardDenialCount; result = $result }
  $process.Dispose()
  return [pscustomobject]$entry
}

function Find-ResultPath {
  param([string]$Output, [string]$ResultsRoot, [string]$TaskId)
  $match = [regex]::Match($Output, "(?im)^Result:\s*(.+result\.json)\s*$")
  if ($match.Success -and (Test-Path -LiteralPath $match.Groups[1].Value.Trim())) { return [System.IO.Path]::GetFullPath($match.Groups[1].Value.Trim()) }
  $taskRoot = Join-Path $ResultsRoot $TaskId
  if (-not (Test-Path -LiteralPath $taskRoot)) { return $null }
  $candidate = Get-ChildItem -LiteralPath $taskRoot -Recurse -Filter result.json -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  return if ($null -eq $candidate) { $null } else { $candidate.FullName }
}

$repoRoot = (Get-Location).Path
$manifestPath = Join-Path $DatasetRoot "public\manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing manifest: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$taskIds = @($manifest.tasks | ForEach-Object { [string]$_.id })
if ($taskIds.Count -eq 0) { throw "Manifest contains no tasks" }

$batchRunId = "simple-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')"
$batchDirectory = Join-Path $DatasetRoot "results\pilot\$batchRunId"
$agentResultsRoot = Join-Path $DatasetRoot "results\$batchRunId"
New-Item -ItemType Directory -Force -Path $batchDirectory | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$entries = @(); $startedAt = (Get-Date).ToUniversalTime()
$pending = [System.Collections.Queue]::new()
foreach ($taskId in $taskIds) { [void]$pending.Enqueue([string]$taskId) }
$active = [System.Collections.Generic.List[object]]::new()

while ($pending.Count -gt 0 -or $active.Count -gt 0) {
  while ($pending.Count -gt 0 -and $active.Count -lt $MaxConcurrency) {
    $taskId = [string]$pending.Dequeue()
    Write-Host "RUN $taskId (active=$($active.Count + 1)/$MaxConcurrency)"
    $taskDirectory = Join-Path $batchDirectory $taskId
    New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
    [void]$active.Add((Start-AgentProcess -TaskId $taskId -TaskDirectory $taskDirectory))
  }

  if ($active.Count -eq 0) { continue }
  $completedIndex = -1
  for ($index = 0; $index -lt $active.Count; $index++) {
    if ($active[$index].process.HasExited) { $completedIndex = $index; break }
  }
  if ($completedIndex -lt 0) {
    Start-Sleep -Milliseconds 100
    continue
  }
  $entry = Complete-AgentProcess -Invocation $active[$completedIndex]
  $active.RemoveAt($completedIndex)
  $entries += $entry
  if ($null -eq $entry.result) { Write-Host "INVALID_TRACE $($entry.taskId) (no result.json, exit=$($entry.exitCode))" } else { Write-Host "DONE $($entry.taskId) agent=$($entry.result.status) evaluation=$($entry.evaluationStatus) trace=$($entry.traceStatus) boundary=$($entry.boundaryStatus)" }
}

$endedAt = (Get-Date).ToUniversalTime()
$completed = @($entries | Where-Object { $_.evaluationStatus -eq "completed" }).Count
$invalidTraceCount = @($entries | Where-Object { $_.evaluationStatus -eq "invalid_trace" }).Count
$contaminatedCount = @($entries | Where-Object { $_.evaluationStatus -eq "contaminated" }).Count
$blockedBoundaryCount = [int](($entries | Measure-Object -Property guardDenialCount -Sum).Sum)
$validTaskCount = $taskIds.Count - $invalidTraceCount - $contaminatedCount
$summary = [ordered]@{ schemaVersion = 3; mode = "simple-agent-observation"; batchRunId = $batchRunId; datasetRoot = $DatasetRoot; maxConcurrency = $MaxConcurrency; taskCount = $taskIds.Count; validTaskCount = $validTaskCount; completedCount = $completed; invalidTraceCount = $invalidTraceCount; contaminatedCount = $contaminatedCount; blockedBoundaryAttemptCount = $blockedBoundaryCount; completionRate = if ($validTaskCount -eq 0) { $null } else { [math]::Round($completed / $validTaskCount, 4) }; startedAt = $startedAt.ToString("o"); endedAt = $endedAt.ToString("o"); durationMs = [int]($endedAt - $startedAt).TotalMilliseconds; tasks = $entries }
$summaryPath = Join-Path $batchDirectory "summary.json"
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding utf8
$markdown = @(
  "# Coding Agent 简化评测批次",
  "",
  "- 批次：$batchRunId",
  "- 最大并发：$MaxConcurrency",
  "- 任务数：$($taskIds.Count)；有效轨迹：$validTaskCount",
  "- Agent 完成数：$completed；完成率：$($summary.completionRate)",
  "- 无效轨迹：$invalidTraceCount；污染运行：$contaminatedCount；已拦截越界：$blockedBoundaryCount",
  "",
  "| 任务 | Agent | 评测状态 | 轨迹 | 边界 | Guard 拒绝 |",
  "|---|---|---|---|---|---:|"
)
foreach ($entry in $entries) {
  $agentStatus = if ($null -eq $entry.result) { "missing" } else { [string]$entry.result.status }
  $markdown += "| $($entry.taskId) | $agentStatus | $($entry.evaluationStatus) | $($entry.traceStatus) | $($entry.boundaryStatus) | $($entry.guardDenialCount) |"
}
$markdown += ""
$markdown += "本批次只记录 Agent 会话、代码差异和强制轨迹门禁；不运行或等待独立 Grader。"
$markdown | Set-Content -LiteralPath (Join-Path $batchDirectory "summary.md") -Encoding utf8
Write-Host "Batch completed: $batchRunId"; Write-Host "Summary: $summaryPath"
if ($invalidTraceCount -gt 0 -or $contaminatedCount -gt 0) {
  Write-Error "Trace gate failed: invalid_trace=$invalidTraceCount contaminated=$contaminatedCount"
  exit 2
}
