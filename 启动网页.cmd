@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 18 或更新版本，再运行此文件。
  pause
  exit /b 1
)
echo 启动后请打开 http://localhost:3000
echo 请保持此窗口运行。按 Ctrl+C 停止服务。
node server.js
pause
