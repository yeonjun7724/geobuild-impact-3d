# Start API + RQ worker + Vite dev server (Windows PowerShell). Logs in backend/data/*.log
$root = Split-Path -Parent $PSScriptRoot
$env:PYTHONIOENCODING = "utf-8"
New-Item -ItemType Directory -Force "$root\backend\data" | Out-Null
Start-Process uv -ArgumentList "run","uvicorn","app.main:app","--host","127.0.0.1","--port","8000" -WorkingDirectory "$root\backend" -RedirectStandardError "$root\backend\data\api.log" -RedirectStandardOutput "$root\backend\data\api.out.log" -WindowStyle Hidden
Start-Process uv -ArgumentList "run","python","-m","app.worker" -WorkingDirectory "$root\backend" -RedirectStandardError "$root\backend\data\worker.log" -RedirectStandardOutput "$root\backend\data\worker.out.log" -WindowStyle Hidden
Start-Process npx -ArgumentList "vite","--port","5173","--host","127.0.0.1" -WorkingDirectory "$root\frontend" -RedirectStandardOutput "$root\backend\data\vite.log" -WindowStyle Hidden
Write-Host "API http://127.0.0.1:8000/docs  ·  Web http://127.0.0.1:5173/projects"
