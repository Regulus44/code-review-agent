[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TaskId,
  [Parameter(Mandatory = $true)]
  [string]$AgentResultPath,
  [string]$DatasetRoot = "D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01",
  [string]$Python = "python",
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
    throw "Refusing to create grader copy inside private root: $candidateFull"
  }
}

function Get-ChangedFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Directory
  )

  $status = Invoke-Process -FilePath "git" -Arguments @("-c", "core.longpaths=true", "status", "--porcelain=v1", "--untracked-files=all") -WorkingDirectory $Directory
  if ($status.exitCode -ne 0) { throw "Could not inspect Git status in $Directory`n$($status.stderr)" }
  return @($status.stdout -split "\r?\n" | Where-Object { $_.Trim().Length -gt 0 } | ForEach-Object {
    $entry = $_
    $path = if ($entry.Length -ge 3) { $entry.Substring(3).Trim().Trim('"') } else { $entry.Trim() }
    if ($path -match '^(?<source>.+) -> (?<destination>.+)$') {
      $Matches.source
      $Matches.destination
    } else {
      $path
    }
  } | Where-Object { $_.Length -gt 0 })
}

function Get-AuditFiles {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Audit,
    [Parameter(Mandatory = $true)]
    [string]$Property
  )

  if ($null -eq $Audit.PSObject.Properties[$Property]) { return @() }
  return @($Audit.$Property | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 } | Sort-Object -Unique)
}

function Assert-SamePathSet {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Left,
    [Parameter(Mandatory = $true)]
    [string[]]$Right,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  $leftSet = @($Left | Sort-Object -Unique)
  $rightSet = @($Right | Sort-Object -Unique)
  $missing = @($leftSet | Where-Object { $_ -notin $rightSet })
  $unexpected = @($rightSet | Where-Object { $_ -notin $leftSet })
  if ($missing.Count -gt 0 -or $unexpected.Count -gt 0) {
    throw "$Description mismatch. missing=$($missing -join ', ') unexpected=$($unexpected -join ', ')"
  }
}

function Get-VenvPython {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskDirectory
  )

  $windowsPython = Join-Path $TaskDirectory "Scripts\python.exe"
  if (Test-Path -LiteralPath $windowsPython) { return $windowsPython }
  $posixPython = Join-Path $TaskDirectory "bin\python"
  if (Test-Path -LiteralPath $posixPython) { return $posixPython }
  return $null
}

function Install-TaskDependencies {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [Parameter(Mandatory = $true)]
    [string]$VenvPath,
    [Parameter(Mandatory = $true)]
    [string]$PythonExecutable,
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  $venvPython = Get-VenvPython -TaskDirectory $VenvPath
  if ($null -eq $venvPython) {
    $created = Invoke-Process -FilePath $PythonExecutable -Arguments @("-m", "venv", "--system-site-packages", $VenvPath) -WorkingDirectory $Workspace
    ($created.stdout + $created.stderr) | Add-Content -LiteralPath $LogPath
    if ($created.exitCode -ne 0) { throw "Could not create venv for $TaskId`n$($created.stderr)" }
    $venvPython = Get-VenvPython -TaskDirectory $VenvPath
  }
  if ($null -eq $venvPython) { throw "Venv Python was not created for $TaskId" }

  $requirements = @("pytest<9", "packaging", "attrs", "pluggy", "iniconfig", "six")
  switch -Regex ($TaskId) {
    '^astropy__' { $requirements += @("pytest-astropy", "scipy") }
    '^matplotlib__' { $requirements += @("pillow", "pyparsing", "python-dateutil", "cycler", "kiwisolver", "fonttools", "contourpy") }
    '^mwaskom__seaborn' { $requirements += @("pandas", "matplotlib", "scipy") }
    '^pallets__flask' { $requirements += @("Werkzeug<2.1", "Jinja2<3.1", "click<8.1", "itsdangerous<2.1") }
    '^psf__requests' { $requirements += @("urllib3", "certifi", "charset-normalizer") }
    '^pydata__xarray' { $requirements += @("pandas", "scipy") }
    '^pylint-dev__pylint' { $requirements += @("astroid", "isort", "mccabe", "toml", "platformdirs") }
    '^pytest-dev__pytest' { $requirements += @("more-itertools") }
    '^django__django' { $requirements += @("asgiref", "pytz", "sqlparse") }
    '^scikit-learn__' { $requirements += @("joblib", "threadpoolctl") }
    '^sphinx-doc__sphinx' { $requirements += @("docutils", "Jinja2", "Pygments", "snowballstemmer", "babel", "alabaster", "imagesize", "requests") }
  }
  $requirements = @($requirements | Sort-Object -Unique)
  $installed = Invoke-Process -FilePath $venvPython -Arguments (@("-m", "pip", "install", "--disable-pip-version-check") + $requirements) -WorkingDirectory $Workspace -TimeoutMs 600000
  ($installed.stdout + $installed.stderr) | Add-Content -LiteralPath $LogPath
  if ($installed.exitCode -ne 0) { throw "Dependency installation failed for $TaskId`n$($installed.stderr)" }
  return $venvPython
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

function Get-TestCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [Parameter(Mandatory = $true)]
    [string]$PythonExecutable,
    [Parameter(Mandatory = $true)]
    [object[]]$Targets
  )

  $normalizedTargets = @($Targets | ForEach-Object { [string]$_ } | Where-Object { $_.Trim().Length -gt 0 })
  if ($Repo -eq "django/django") {
    $djangoTargets = @($normalizedTargets | ForEach-Object { Convert-DjangoTestTarget -Target $_ })
    return [pscustomobject]@{
      runner = "django-native"
      filePath = $PythonExecutable
      arguments = @("tests/runtests.py") + $djangoTargets + @("--verbosity", "0")
      environment = @{ PYTHONPATH = $Workspace }
      targets = $djangoTargets
    }
  }
  return [pscustomobject]@{
    runner = "pytest"
    filePath = $PythonExecutable
    arguments = @("-m", "pytest", "-q", "-W", "ignore::DeprecationWarning") + $normalizedTargets
    environment = @{ PYTHONPATH = $env:PYTHONPATH }
    targets = $normalizedTargets
  }
}

function Write-TestAdapterLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,
    [Parameter(Mandatory = $true)]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [object]$Command
  )

  $record = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    phase = $Phase
    runner = $Command.runner
    filePath = $Command.filePath
    arguments = @($Command.arguments)
    targets = @($Command.targets)
    environment = $Command.environment
  }
  ($record | ConvertTo-Json -Depth 8 -Compress) | Add-Content -LiteralPath $LogPath
}

$agentResultFull = [System.IO.Path]::GetFullPath($AgentResultPath)
if (-not (Test-Path -LiteralPath $agentResultFull)) { throw "Missing Agent result: $agentResultFull" }
$agentResult = Get-Content -LiteralPath $agentResultFull -Raw | ConvertFrom-Json
$agentRunDirectory = Split-Path -Parent $agentResultFull
$agentDiffPath = if ($agentResult.diff.path) { [System.IO.Path]::GetFullPath([string]$agentResult.diff.path) } else { Join-Path $agentRunDirectory "agent.diff" }
$scopeAuditPath = if ($agentResult.diff.scopeAuditPath) { [System.IO.Path]::GetFullPath([string]$agentResult.diff.scopeAuditPath) } elseif ($agentResult.scopeAudit.path) { [System.IO.Path]::GetFullPath([string]$agentResult.scopeAudit.path) } else { Join-Path $agentRunDirectory "scope-audit.json" }
$agentWorkspace = if ($agentResult.workspace) { [System.IO.Path]::GetFullPath([string]$agentResult.workspace) } else { $null }
$taskPath = Join-Path $DatasetRoot "public\tasks\$TaskId\task.json"
$baseWorkspace = Join-Path $DatasetRoot "runtime\workspaces\$TaskId"
$goldPatchPath = Join-Path $DatasetRoot "private\gold-patches\$TaskId.patch"
$testPatchPath = Join-Path $DatasetRoot "private\test-patches\$TaskId.patch"
$privateRoot = Join-Path $DatasetRoot "private"

foreach ($required in @($taskPath, $baseWorkspace, $goldPatchPath, $testPatchPath, $agentDiffPath, $scopeAuditPath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing required path: $required" }
}
Assert-PathOutside -Candidate $agentDiffPath -ForbiddenRoot $privateRoot
Assert-PathOutside -Candidate $scopeAuditPath -ForbiddenRoot $privateRoot
if ($null -eq $agentWorkspace -or -not (Test-Path -LiteralPath $agentWorkspace)) { throw "Missing Agent workspace in result: $agentWorkspace" }
Assert-PathOutside -Candidate $agentWorkspace -ForbiddenRoot $privateRoot

$task = Get-Content -LiteralPath $taskPath -Raw | ConvertFrom-Json
$scopeAudit = Get-Content -LiteralPath $scopeAuditPath -Raw | ConvertFrom-Json
if ($scopeAudit.schemaVersion -ne 1) { throw "Unsupported scope audit schema: $($scopeAudit.schemaVersion)" }
$graderRunId = "grader-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')"
$graderDirectory = Join-Path $agentRunDirectory $graderRunId
$cleanCopy = Join-Path $graderDirectory "clean-copy"
$graderResultPath = Join-Path $graderDirectory "grader-result.json"
$graderLogPath = Join-Path $graderDirectory "grader.log"
$failOutputPath = Join-Path $graderDirectory "fail-to-pass.txt"
$passOutputPath = Join-Path $graderDirectory "pass-to-pass.txt"
$venvPath = Join-Path $DatasetRoot "runtime\venvs\$TaskId"
$startedAt = (Get-Date).ToUniversalTime()
$phase = "provision"
$failureClass = $null
$scopeViolation = $false
$securityViolation = $false
$agentChangedFiles = @()
$cleanChangedFiles = @()
$failToPassStatus = "not_run"
$passToPassStatus = "not_run"
$failExitCode = $null
$passExitCode = $null
$testTimedOut = $false
$pythonExecutable = $Python
$sourcePath = $null
$errorMessage = $null

New-Item -ItemType Directory -Force -Path $graderDirectory | Out-Null
Assert-PathOutside -Candidate $cleanCopy -ForbiddenRoot $privateRoot

try {
  $phase = "scope_check"
  $scopeViolation = [bool]$scopeAudit.scopeViolation
  $auditedAllFiles = Get-AuditFiles -Audit $scopeAudit -Property "allChangedFiles"
  $auditedCandidateFiles = Get-AuditFiles -Audit $scopeAudit -Property "candidateChangedFiles"
  $reportedChangedFiles = Get-AuditFiles -Audit $agentResult.diff -Property "changedFiles"
  Assert-SamePathSet -Left $auditedAllFiles -Right $reportedChangedFiles -Description "Agent result changedFiles and scope audit allChangedFiles"
  if ($scopeAudit.allowedPaths -ne $null -and $task.allowedPaths -ne $null) {
    Assert-SamePathSet -Left (Get-AuditFiles -Audit $scopeAudit -Property "allowedPaths") -Right (Get-AuditFiles -Audit $task -Property "allowedPaths") -Description "Scope audit allowedPaths and task allowedPaths"
  }
  if ($scopeAudit.forbiddenPaths -ne $null -and $task.forbiddenPaths -ne $null) {
    Assert-SamePathSet -Left (Get-AuditFiles -Audit $scopeAudit -Property "forbiddenPaths") -Right (Get-AuditFiles -Audit $task -Property "forbiddenPaths") -Description "Scope audit forbiddenPaths and task forbiddenPaths"
  }
  if ($agentResult.diff.scopeViolation -ne $null -and [bool]$agentResult.diff.scopeViolation -ne $scopeViolation) {
    throw "Agent result scopeViolation does not match scope audit"
  }
  if ($scopeViolation) {
    $violationSummary = @($scopeAudit.violations | ForEach-Object { "$($_.kind):$($_.path)" }) -join ", "
    throw "Agent workspace scope audit failed: $violationSummary"
  }
  $workspaceFiles = Get-ChangedFiles -Directory $agentWorkspace
  Assert-SamePathSet -Left $auditedAllFiles -Right $workspaceFiles -Description "Scope audit and Agent workspace Git status"
  $phase = "provision"

  # Force LF checkout during clone. The host may globally set core.autocrlf=true;
  # that would make the clean copy differ byte-for-byte from the Agent diff and
  # cause git apply to fail before tests even start.
  $clone = Invoke-Process -FilePath "git" -Arguments @("-c", "core.longpaths=true", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "--no-local", "--quiet", $baseWorkspace, $cleanCopy) -WorkingDirectory $graderDirectory
  ($clone.stdout + $clone.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($clone.exitCode -ne 0) { throw "Could not clone clean copy`n$($clone.stderr)" }
  $autocrlf = Invoke-Process -FilePath "git" -Arguments @("config", "core.autocrlf", "false") -WorkingDirectory $cleanCopy
  ($autocrlf.stdout + $autocrlf.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($autocrlf.exitCode -ne 0) { throw "Could not disable autocrlf in clean copy`n$($autocrlf.stderr)" }
  $longPathsBeforeReset = Invoke-Process -FilePath "git" -Arguments @("config", "core.longpaths", "true") -WorkingDirectory $cleanCopy
  ($longPathsBeforeReset.stdout + $longPathsBeforeReset.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($longPathsBeforeReset.exitCode -ne 0) { throw "Could not enable long paths before checkout normalization`n$($longPathsBeforeReset.stderr)" }
  $normalizeCheckout = Invoke-Process -FilePath "git" -Arguments @("reset", "--hard", "--quiet", "HEAD") -WorkingDirectory $cleanCopy
  ($normalizeCheckout.stdout + $normalizeCheckout.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($normalizeCheckout.exitCode -ne 0) { throw "Could not normalize clean copy checkout`n$($normalizeCheckout.stderr)" }
  # Re-materialize tracked files after changing checkout settings. This handles
  # clones created from a workspace whose files were already CRLF-normalized.
  $forceCheckout = Invoke-Process -FilePath "git" -Arguments @("-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "--all", "--force") -WorkingDirectory $cleanCopy
  ($forceCheckout.stdout + $forceCheckout.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($forceCheckout.exitCode -ne 0) { throw "Could not force LF checkout normalization`n$($forceCheckout.stderr)" }
  $enableLongPaths = Invoke-Process -FilePath "git" -Arguments @("config", "core.longpaths", "true") -WorkingDirectory $cleanCopy
  ($enableLongPaths.stdout + $enableLongPaths.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($enableLongPaths.exitCode -ne 0) { throw "Could not enable long paths in clean copy`n$($enableLongPaths.stderr)" }
  $initialFiles = Get-ChangedFiles -Directory $cleanCopy
  if (@($initialFiles).Count -gt 0) { throw "Clean copy is not clean: $($initialFiles -join ', ')" }

  $phase = "apply_agent_patch"
  if ((Get-Item -LiteralPath $agentDiffPath).Length -gt 0) {
    $applyAgent = Invoke-Process -FilePath "git" -Arguments @("-c", "core.longpaths=true", "apply", "--whitespace=nowarn", "--binary", $agentDiffPath) -WorkingDirectory $cleanCopy
    ($applyAgent.stdout + $applyAgent.stderr) | Add-Content -LiteralPath $graderLogPath
    if ($applyAgent.exitCode -ne 0) { throw "Agent diff could not be applied`n$($applyAgent.stderr)" }
  }
  $phase = "scope_check"
  $cleanChangedFiles = Get-ChangedFiles -Directory $cleanCopy
  $agentChangedFiles = @($cleanChangedFiles)
  Assert-SamePathSet -Left $auditedCandidateFiles -Right $cleanChangedFiles -Description "Agent diff and scope audit candidate files"

  $phase = "security_check"
  $privateLeak = @(Get-ChildItem -LiteralPath $cleanCopy -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
      $_.FullName -match "\\(private|gold-patches|test-patches)(\\|$)" -or $_.Extension -eq ".patch"
    })
  $securityViolation = $privateLeak.Count -gt 0
  if ($securityViolation) { throw "Private dataset artifacts leaked into clean copy" }

  $phase = "apply_hidden_patch"
  $applyHidden = Invoke-Process -FilePath "git" -Arguments @("-c", "core.longpaths=true", "apply", "--whitespace=nowarn", "--binary", $testPatchPath) -WorkingDirectory $cleanCopy
  ($applyHidden.stdout + $applyHidden.stderr) | Add-Content -LiteralPath $graderLogPath
  if ($applyHidden.exitCode -ne 0) { throw "Hidden test patch could not be applied`n$($applyHidden.stderr)" }

  $phase = "prepare_dependencies"
  if ($InstallDependencies) {
    $pythonExecutable = Install-TaskDependencies -TaskId $TaskId -Workspace $cleanCopy -VenvPath $venvPath -PythonExecutable $Python -LogPath $graderLogPath
  }
  $sourcePath = if (Test-Path -LiteralPath (Join-Path $cleanCopy "src")) {
    Join-Path $cleanCopy "src"
  } elseif (Test-Path -LiteralPath (Join-Path $cleanCopy "lib")) {
    Join-Path $cleanCopy "lib"
  } else {
    $cleanCopy
  }
  $previousPythonPath = $env:PYTHONPATH
  $env:PYTHONPATH = if ([string]::IsNullOrWhiteSpace($previousPythonPath)) { $sourcePath } else { "$sourcePath;$previousPythonPath" }
  try {
    if ($task.repo -ne "django/django") {
      $probe = Invoke-Process -FilePath $pythonExecutable -Arguments @("-m", "pytest", "--version") -WorkingDirectory $cleanCopy -TimeoutMs 60000
      if ($probe.exitCode -ne 0) { throw "pytest unavailable: $($probe.stderr)" }
    }

    $phase = "run_fail_to_pass"
    $failCommand = Get-TestCommand -Repo ([string]$task.repo) -Workspace $cleanCopy -PythonExecutable $pythonExecutable -Targets @($task.failToPass)
    Write-TestAdapterLog -LogPath $graderLogPath -Phase $phase -Command $failCommand
    $failRun = Invoke-Process -FilePath $failCommand.filePath -Arguments $failCommand.arguments -WorkingDirectory $cleanCopy -Environment $failCommand.environment -TimeoutMs $TestTimeoutMs
    ($failRun.stdout + $failRun.stderr) | Set-Content -LiteralPath $failOutputPath -Encoding utf8
    $failExitCode = $failRun.exitCode
    $testTimedOut = $testTimedOut -or $failRun.timedOut
    $failToPassStatus = if ($failRun.timedOut) { "timeout" } elseif ($failRun.exitCode -eq 0) { "passed" } else { "failed" }

    $phase = "run_pass_to_pass"
    $passCommand = Get-TestCommand -Repo ([string]$task.repo) -Workspace $cleanCopy -PythonExecutable $pythonExecutable -Targets @($task.passToPass)
    Write-TestAdapterLog -LogPath $graderLogPath -Phase $phase -Command $passCommand
    $passRun = Invoke-Process -FilePath $passCommand.filePath -Arguments $passCommand.arguments -WorkingDirectory $cleanCopy -Environment $passCommand.environment -TimeoutMs $TestTimeoutMs
    ($passRun.stdout + $passRun.stderr) | Set-Content -LiteralPath $passOutputPath -Encoding utf8
    $passExitCode = $passRun.exitCode
    $testTimedOut = $testTimedOut -or $passRun.timedOut
    $passToPassStatus = if ($passRun.timedOut) { "timeout" } elseif ($passRun.exitCode -eq 0) { "passed" } else { "failed" }
    if ($testTimedOut) {
      $failureClass = "timeout"
    } elseif ($failToPassStatus -ne "passed" -or $passToPassStatus -ne "passed") {
      $failureClass = "test_failed"
    }
    $phase = "completed"
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }
} catch {
  $errorMessage = $_.Exception.Message
  $failureClass = if ($testTimedOut) { "timeout" } elseif ($scopeViolation -or $phase -eq "scope_check") { "scope_violation" } elseif ($securityViolation) { "security_violation" } elseif ($phase -in @("run_fail_to_pass", "run_pass_to_pass")) { "test_failed" } elseif ($phase -in @("apply_agent_patch", "apply_hidden_patch")) { "grader_failed" } else { "infra_error" }
  $_ | Out-String | Add-Content -LiteralPath $graderLogPath
}

$endedAt = (Get-Date).ToUniversalTime()
$status = if ($phase -eq "completed" -and $failToPassStatus -eq "passed" -and $passToPassStatus -eq "passed" -and -not $scopeViolation -and -not $securityViolation) { "passed" } elseif ($failureClass -in @("scope_violation", "security_violation", "test_failed", "timeout")) { "failed" } else { "infra_error" }
$result = [ordered]@{
  schemaVersion = 1
  taskId = $TaskId
  datasetVersion = "pilot-01"
  status = $status
  phase = $phase
  failureClass = $failureClass
  error = $errorMessage
  startedAt = $startedAt.ToString("o")
  endedAt = $endedAt.ToString("o")
  durationMs = [int]($endedAt - $startedAt).TotalMilliseconds
  agentResultPath = $agentResultFull
  agentWorkspace = $agentWorkspace
  provider = $agentResult.provider
  model = $agentResult.model
  turnStatus = $agentResult.turnStatus
  agentStatus = $agentResult.status
  agentChangedFiles = @($agentChangedFiles)
  auditedChangedFiles = @(Get-AuditFiles -Audit $scopeAudit -Property "allChangedFiles")
  auditedCandidateFiles = @(Get-AuditFiles -Audit $scopeAudit -Property "candidateChangedFiles")
  runtimeArtifactFiles = @(Get-AuditFiles -Audit $scopeAudit -Property "runtimeArtifactFiles")
  scopeViolation = $scopeViolation
  securityViolation = $securityViolation
  grader = [ordered]@{
    failToPass = $failToPassStatus
    passToPass = $passToPassStatus
    failToPassExitCode = $failExitCode
    passToPassExitCode = $passExitCode
    testTimedOut = $testTimedOut
  }
  paths = [ordered]@{
    cleanCopy = $cleanCopy
    agentDiff = $agentDiffPath
    hiddenPatch = "outside clean copy"
    failToPassOutput = $failOutputPath
    passToPassOutput = $passOutputPath
    graderLog = $graderLogPath
  }
}
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $graderResultPath -Encoding utf8
Write-Host "Grader completed: task=$TaskId status=$status failToPass=$failToPassStatus passToPass=$passToPassStatus"
Write-Host "Result: $graderResultPath"
