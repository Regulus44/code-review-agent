[CmdletBinding()]
param([string]$DatasetRoot = "D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01")

$ErrorActionPreference = "Stop"

function Invoke-Process {
  param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment = @{})
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath; $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true; $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
  foreach ($entry in $Environment.GetEnumerator()) { $startInfo.Environment[$entry.Key] = [string]$entry.Value }
  $process = [System.Diagnostics.Process]::new(); $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Could not start process: $FilePath" }
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [pscustomobject]@{ exitCode = $process.ExitCode; stdout = $stdout.Result; stderr = $stderr.Result }
  } finally { $process.Dispose() }
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

foreach ($taskId in $taskIds) {
  Write-Host "RUN $taskId"
  $taskDirectory = Join-Path $batchDirectory $taskId
  New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
  $environment = @{ CODING_AGENT_DATASET_ROOT = $DatasetRoot; CODING_AGENT_RUN_GROUP = $batchRunId; CODING_AGENT_RUN_ID_PREFIX = "run" }
  $process = Invoke-Process -FilePath $nodePath -Arguments @("--env-file-if-exists=.env", "--import", "tsx", "scripts/eval-mvp/run-agent-task.ts", $taskId) -WorkingDirectory $repoRoot -Environment $environment
  $logPath = Join-Path $taskDirectory "agent-run.log"
  ($process.stdout + $process.stderr) | Set-Content -LiteralPath $logPath -Encoding utf8
  $resultPath = Find-ResultPath -Output ($process.stdout + $process.stderr) -ResultsRoot $agentResultsRoot -TaskId $taskId
  $result = if ($null -eq $resultPath) { $null } else { Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json }
  $traceStatus = if ($null -eq $result -or [string]::IsNullOrWhiteSpace([string]$result.traceStatus)) { "missing" } else { [string]$result.traceStatus }
  $boundaryStatus = if ($null -eq $result -or [string]::IsNullOrWhiteSpace([string]$result.boundaryStatus)) { "unknown" } else { [string]$result.boundaryStatus }
  $evaluationStatus = if ($null -eq $result -or $traceStatus -ne "complete") { "invalid_trace" } elseif ($boundaryStatus -eq "contaminated") { "contaminated" } elseif ([string]::IsNullOrWhiteSpace([string]$result.evaluationStatus)) { [string]$result.status } else { [string]$result.evaluationStatus }
  $guardDenialCount = if ($null -eq $result -or $null -eq $result.trace) { 0 } else { @($result.trace.guardDenials).Count }
  $entries += [ordered]@{ taskId = $taskId; exitCode = $process.exitCode; resultPath = $resultPath; logPath = $logPath; evaluationStatus = $evaluationStatus; traceStatus = $traceStatus; boundaryStatus = $boundaryStatus; guardDenialCount = $guardDenialCount; result = $result }
  if ($null -eq $result) { Write-Host "INVALID_TRACE $taskId (no result.json, exit=$($process.exitCode))" } else { Write-Host "DONE $taskId agent=$($result.status) evaluation=$evaluationStatus trace=$traceStatus boundary=$boundaryStatus" }
}

$endedAt = (Get-Date).ToUniversalTime()
$completed = @($entries | Where-Object { $_.evaluationStatus -eq "completed" }).Count
$invalidTraceCount = @($entries | Where-Object { $_.evaluationStatus -eq "invalid_trace" }).Count
$contaminatedCount = @($entries | Where-Object { $_.evaluationStatus -eq "contaminated" }).Count
$blockedBoundaryCount = [int](($entries | Measure-Object -Property guardDenialCount -Sum).Sum)
$validTaskCount = $taskIds.Count - $invalidTraceCount - $contaminatedCount
$summary = [ordered]@{ schemaVersion = 3; mode = "simple-agent-observation"; batchRunId = $batchRunId; datasetRoot = $DatasetRoot; taskCount = $taskIds.Count; validTaskCount = $validTaskCount; completedCount = $completed; invalidTraceCount = $invalidTraceCount; contaminatedCount = $contaminatedCount; blockedBoundaryAttemptCount = $blockedBoundaryCount; completionRate = if ($validTaskCount -eq 0) { $null } else { [math]::Round($completed / $validTaskCount, 4) }; startedAt = $startedAt.ToString("o"); endedAt = $endedAt.ToString("o"); durationMs = [int]($endedAt - $startedAt).TotalMilliseconds; tasks = $entries }
$summaryPath = Join-Path $batchDirectory "summary.json"
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding utf8
$markdown = @(
  "# Coding Agent 简化评测批次",
  "",
  "- 批次：$batchRunId",
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
