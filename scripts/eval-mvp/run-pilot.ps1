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
  $entries += [ordered]@{ taskId = $taskId; exitCode = $process.exitCode; resultPath = $resultPath; logPath = $logPath; result = $result }
  if ($null -eq $result) { Write-Host "FAILED $taskId (no result.json, exit=$($process.exitCode))" } else { Write-Host "DONE $taskId status=$($result.status)" }
}

$endedAt = (Get-Date).ToUniversalTime()
$completed = @($entries | Where-Object { $null -ne $_.result -and $_.result.status -eq "completed" }).Count
$summary = [ordered]@{ schemaVersion = 2; mode = "simple-agent-observation"; batchRunId = $batchRunId; datasetRoot = $DatasetRoot; taskCount = $taskIds.Count; completedCount = $completed; completionRate = [math]::Round($completed / $taskIds.Count, 4); startedAt = $startedAt.ToString("o"); endedAt = $endedAt.ToString("o"); durationMs = [int]($endedAt - $startedAt).TotalMilliseconds; tasks = $entries }
$summaryPath = Join-Path $batchDirectory "summary.json"
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding utf8
@("# Coding Agent 简化评测批次", "", "- 批次：$batchRunId", "- 任务数：$($taskIds.Count)", "- Agent 完成数：$completed", "- 完成率：$($summary.completionRate)", "", "本批次只记录 Agent 会话结果、日志和代码差异；不运行或等待独立 Grader。") | Set-Content -LiteralPath (Join-Path $batchDirectory "summary.md") -Encoding utf8
Write-Host "Batch completed: $batchRunId"; Write-Host "Summary: $summaryPath"
