@echo off
setlocal
cd /d "%~dp0.."
call npm install || exit /b 1
call npm test || exit /b 1
call npm run desktop:build
