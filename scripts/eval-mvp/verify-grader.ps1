[CmdletBinding()]
param(
  [ValidateSet("gold", "empty")]
  [string]$Mode = "gold",
  [string]$TaskId = "pallets__flask-4045",
  [string]$DatasetRoot = "D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01",
  [string]$Python = "python",
  [switch]$InstallDependencies
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
  )

  $output = if ($null -eq $WorkingDirectory) {
    & $FilePath @ArgumentList 2>&1
  } else {
    Push-Location $WorkingDirectory
    try { & $FilePath @ArgumentList 2>&1 } finally { Pop-Location }
  }
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $message = ($output | Out-String).Trim()
    throw "Command failed ($exitCode): $FilePath $($ArgumentList -join ' ')`n$message"
  }
  return @($output)
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  Push-Location $WorkingDirectory
  try {
    $output = @(& $FilePath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    output = $output
    exitCode = $exitCode
  }
}

function Assert-PathOutside {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Candidate,
    [Parameter(Mandatory = $true)]
    [string]$ForbiddenRoot
  )

  $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $forbiddenFull = [System.IO.Path]::GetFullPath($ForbiddenRoot).TrimEnd('\')
  if ($candidateFull.Equals($forbiddenFull, [System.StringComparison]::OrdinalIgnoreCase) -or
      $candidateFull.StartsWith($forbiddenFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a clean copy inside forbidden root: $candidateFull"
  }
}

function Convert-DjangoTestTarget {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target
  )
  $trimmed = $Target.Trim()
  if ($trimmed -match '^(?<method>[A-Za-z_]\w*)\s+\((?<qualified>[^)]+)\)$') {
    return "$($Matches.qualified).$($Matches.method)"
  }
  return $trimmed
}

$taskPath = Join-Path $DatasetRoot "public\tasks\$TaskId\task.json"
$workspace = Join-Path $DatasetRoot "runtime\workspaces\$TaskId"
$goldPatch = Join-Path $DatasetRoot "private\gold-patches\$TaskId.patch"
$testPatch = Join-Path $DatasetRoot "private\test-patches\$TaskId.patch"
$privateRoot = Join-Path $DatasetRoot "private"
$resultsRoot = Join-Path $DatasetRoot "results\grader-selftest"

foreach ($required in @($taskPath, $workspace, $testPatch)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing required path: $required" }
}
if ($Mode -eq "gold" -and -not (Test-Path -LiteralPath $goldPatch)) {
  throw "Missing gold patch: $goldPatch"
}

$task = Get-Content -LiteralPath $taskPath -Raw | ConvertFrom-Json
$workspaceStatus = & git -C $workspace status --porcelain 2>&1
if ($LASTEXITCODE -ne 0) { throw "Workspace is not a Git repository: $workspace" }
if (-not [string]::IsNullOrWhiteSpace(($workspaceStatus | Out-String))) {
  throw "Workspace must be clean before Grader self-test: $workspace`n$($workspaceStatus | Out-String)"
}

$runId = "grader-selftest-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')-$Mode"
$runDirectory = Join-Path $resultsRoot (Join-Path $TaskId $runId)
$cleanCopy = Join-Path $runDirectory "clean-copy"
$logPath = Join-Path $runDirectory "grader.log"
$resultPath = Join-Path $runDirectory "result.json"
$eventsPath = Join-Path $runDirectory "events.jsonl"

New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
Assert-PathOutside -Candidate $cleanCopy -ForbiddenRoot $privateRoot
New-Item -ItemType File -Force -Path $eventsPath | Out-Null

$startedAt = (Get-Date).ToUniversalTime()
$phase = "provision"
$failureClass = $null
$testOutput = @()
$testExitCode = $null
$agentChangedFiles = @()
$hiddenChangedFiles = @()
$pythonExecutable = $Python
$venvPath = $null

try {
  Invoke-Checked -FilePath "git" -ArgumentList @("-c", "core.longpaths=true", "-c", "core.autocrlf=false", "clone", "--no-local", "--quiet", $workspace, $cleanCopy) | Out-File -FilePath $logPath -Encoding utf8

  # The source checkout may carry a user-level autocrlf setting. Normalize the
  # disposable clean copy before checking status so line-ending conversion is
  # never mistaken for a patch or grader change.
  Invoke-Checked -FilePath "git" -ArgumentList @("-C", $cleanCopy, "config", "core.autocrlf", "false") | Add-Content -LiteralPath $logPath
  Invoke-Checked -FilePath "git" -ArgumentList @("-C", $cleanCopy, "config", "core.longpaths", "true") | Add-Content -LiteralPath $logPath
  Invoke-Checked -FilePath "git" -ArgumentList @("-C", $cleanCopy, "reset", "--hard", "--quiet", "HEAD") | Add-Content -LiteralPath $logPath

  $cleanStatus = & git -C $cleanCopy status --porcelain 2>&1
  if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace(($cleanStatus | Out-String))) {
    throw "Clean copy is not clean: $cleanCopy`n$($cleanStatus | Out-String)"
  }

  $phase = "apply_agent_patch"
  if ($Mode -eq "gold") {
    Invoke-Checked -FilePath "git" -ArgumentList @("-C", $cleanCopy, "apply", "--whitespace=nowarn", $goldPatch) | Add-Content -LiteralPath $logPath
  }

  $agentChangedFiles = @(& git -C $cleanCopy diff --name-only 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Could not collect Agent diff files" }

  $privateLeak = Get-ChildItem -LiteralPath $cleanCopy -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @("private", "gold-patches", "test-patches") -or $_.Extension -eq ".patch"
    }
  if ($null -ne $privateLeak -and @($privateLeak).Count -gt 0) {
    throw "Private dataset artifacts leaked into clean copy"
  }

  $phase = "apply_hidden_patch"
  Invoke-Checked -FilePath "git" -ArgumentList @("-C", $cleanCopy, "apply", "--whitespace=nowarn", $testPatch) | Add-Content -LiteralPath $logPath
  $hiddenChangedFiles = @(& git -C $cleanCopy diff --name-only 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Could not collect hidden patch files" }

  if (-not $task.failToPass -or @($task.failToPass).Count -eq 0) {
    throw "Task has no failToPass tests: $TaskId"
  }

  if ($InstallDependencies) {
    $venvPath = Join-Path $DatasetRoot "runtime\venvs\$TaskId"
    if (-not (Test-Path -LiteralPath (Join-Path $venvPath "Scripts\python.exe"))) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $venvPath) | Out-Null
      Invoke-Checked -FilePath $Python -ArgumentList @("-m", "venv", $venvPath) | Add-Content -LiteralPath $logPath
    }
    $pythonExecutable = Join-Path $venvPath "Scripts\python.exe"
    Invoke-Checked -FilePath $pythonExecutable -ArgumentList @("-m", "pip", "install", "--disable-pip-version-check", "pytest<9", "Werkzeug<2.1", "Jinja2<3.1", "click<8.1", "itsdangerous<2.1") | Add-Content -LiteralPath $logPath
  }

  $previousPythonPath = $env:PYTHONPATH
  $sourcePath = Join-Path $cleanCopy "src"
  $env:PYTHONPATH = if ([string]::IsNullOrWhiteSpace($previousPythonPath)) {
    $sourcePath
  } else {
    "$sourcePath;$previousPythonPath"
  }
  try {
    if ($task.repo -ne "django/django") {
      $pytestProbe = Invoke-Captured -FilePath $pythonExecutable -ArgumentList @("-m", "pytest", "--version") -WorkingDirectory $cleanCopy
      if ($pytestProbe.exitCode -ne 0) {
        throw "pytest is unavailable. Re-run with -InstallDependencies or provide -Python pointing to an environment with pytest."
      }
    }

    $phase = "run_tests"
    # The pilot contains legacy Python repositories. Their tests treat all
    # warnings as errors, while Python 3.13 emits deprecations for APIs removed
    # in later versions. Ignore only DeprecationWarning so this self-test does
    # not confuse an environment mismatch with a patch failure.
    if ($task.repo -eq "django/django") {
      $testArgs = @("tests/runtests.py")
      $testArgs += @($task.failToPass | ForEach-Object { Convert-DjangoTestTarget -Target ([string]$_) })
      $testArgs += @($task.passToPass | ForEach-Object { Convert-DjangoTestTarget -Target ([string]$_) })
      $testArgs += @("--verbosity", "0")
      $env:PYTHONPATH = if ([string]::IsNullOrWhiteSpace($previousPythonPath)) { $cleanCopy } else { "$cleanCopy;$previousPythonPath" }
    } else {
      $testArgs = @("-m", "pytest", "-q", "-W", "ignore::DeprecationWarning")
      $testArgs += @($task.failToPass | ForEach-Object { [string]$_ })
      $testArgs += @($task.passToPass | ForEach-Object { [string]$_ })
    }
    "$(Get-Date -Format o) adapter=$([string]$(if ($task.repo -eq 'django/django') { 'django-native' } else { 'pytest' })) args=$($testArgs -join ' ') PYTHONPATH=$env:PYTHONPATH" | Add-Content -LiteralPath $logPath
    $testResult = Invoke-Captured -FilePath $pythonExecutable -ArgumentList $testArgs -WorkingDirectory $cleanCopy
    $testOutput = @($testResult.output)
    $testExitCode = $testResult.exitCode
    $testOutput | Set-Content -LiteralPath (Join-Path $runDirectory "test-output.txt") -Encoding utf8

    $expectedPass = $Mode -eq "gold"
    $actualPass = $testExitCode -eq 0
    if ($actualPass -ne $expectedPass) {
      throw "Unexpected Grader outcome for mode '$Mode': expected pass=$expectedPass, exitCode=$testExitCode"
    }
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }

  $phase = "completed"
} catch {
  $failureClass = if ($phase -eq "run_tests") { "test_failed" } elseif ($phase -eq "apply_hidden_patch" -or $phase -eq "apply_agent_patch") { "grader_failed" } else { "infra_error" }
  $_ | Out-String | Add-Content -LiteralPath $logPath
  throw
} finally {
  $endedAt = (Get-Date).ToUniversalTime()
  $result = [ordered]@{
    schemaVersion = 1
    runId = $runId
    taskId = $TaskId
    mode = $Mode
    datasetVersion = "pilot-01"
    status = if ($phase -eq "completed") { "passed" } else { "failed" }
    expectedOutcome = if ($Mode -eq "gold") { "pass" } else { "fail" }
    phase = $phase
    failureClass = $failureClass
    startedAt = $startedAt.ToString("o")
    endedAt = $endedAt.ToString("o")
    durationMs = [int]($endedAt - $startedAt).TotalMilliseconds
    workspace = $workspace
    cleanCopy = $cleanCopy
    baseRevision = (& git -C $workspace rev-parse HEAD 2>$null)
    agentChangedFiles = @($agentChangedFiles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    hiddenChangedFiles = @($hiddenChangedFiles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    testExitCode = $testExitCode
    testCount = @($task.failToPass).Count + @($task.passToPass).Count
    testOutputPath = (Join-Path $runDirectory "test-output.txt")
    graderLogPath = $logPath
    eventsPath = $eventsPath
    privateArtifactsOutsideCleanCopy = $true
  }
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding utf8
}

Write-Host "Grader self-test passed: mode=$Mode task=$TaskId"
Write-Host "Result: $resultPath"
