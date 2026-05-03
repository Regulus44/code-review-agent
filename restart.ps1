$port = 8000
$p = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess
if ($p) { Stop-Process -Id $p -Force; Write-Host "stopped port $port" }

Set-Location $PSScriptRoot
Start-Process -WindowStyle Hidden D:\Anaconda\envs\dl\python.exe -ArgumentList "-m", "uvicorn", "code_review_agent.api.app:create_app", "--factory", "--host", "127.0.0.1", "--port", "$port", "--reload"

Write-Host "started on http://127.0.0.1:$port"
