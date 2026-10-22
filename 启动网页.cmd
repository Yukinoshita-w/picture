@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20 或更新版本，建议使用 Node.js 24 LTS，再运行此文件。
  pause
  exit /b 1
)
echo 启动后请打开 http://localhost:3000
echo 请保持此窗口运行。按 Ctrl+C 停止服务。
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo 当前 Node.js 较旧，将使用 Node.js 24 启动。首次需要联网下载运行时。
  call npm exec --yes --package=node@24 -- node server.js
) else (
  node server.js
)
pause
