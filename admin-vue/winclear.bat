@echo off
chcp 65001 >nul
title 一键删除 node_modules
echo ==============================================
echo          一键删除 node_modules
echo ==============================================
echo.

echo 正在删除 node_modules...
rd /s /q node_modules 2>nul

echo 正在删除 pnpm-lock.yaml...
del /f /q pnpm-lock.yaml 2>nul

echo.
echo ==============================================
echo              清理完成!
echo ==============================================
pause