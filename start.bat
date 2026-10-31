@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4321/api/health' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  node open-ui.js http://127.0.0.1:4321
  exit /b 0
)

if not exist data mkdir data
set AUTO_OPEN=1
node quick-server.js
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Node.js 20 或更高版本，并查看上方错误信息。
  pause
)
