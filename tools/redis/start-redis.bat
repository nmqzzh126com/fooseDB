@echo off
cd /d "%~dp0"
title Redis 5.0.14.1 - 127.0.0.1:6379 (in-memory)
echo ============================================
echo   Redis 5.0.14.1 starting...
echo   Bind: 127.0.0.1  Port: 6379
echo   Mode: in-memory (no persistence)
echo   Close this window to stop Redis.
echo ============================================
redis-server.exe --bind 127.0.0.1 --port 6379 --save "" --appendonly no
pause
