@echo off
title KOT Printer Online
color 0A
echo.
echo  ============================================
echo   KOT Printer Online
echo  ============================================
echo.

REM ===================================================
REM  SETTINGS - Change these for your shop
REM ===================================================

REM Your cloud Odoo URL (include http:// and port)
set ODOO_URL=http://localhost:8069

REM Database name (leave empty to auto-detect)
set ODOO_DB=

REM Odoo login credentials
set ODOO_USER=admin
set ODOO_PASS=admin

REM Local printer IP and port (on your LAN)
set PRINTER_IP=127.0.0.1
set PRINTER_PORT=9100

REM Poll interval in seconds
set POLL_INTERVAL=2

REM ===================================================

REM Install required package
pip install requests --quiet 2>nul

echo.
echo  Starting KOT Print Agent...
echo  Press Ctrl+C to stop
echo.

REM TEST mode (shows KOT in CMD window, no real printer needed)
python "%~dp0print_agent.py"

REM To use REAL printer, comment the line above and uncomment below:
REM python "%~dp0print_agent.py" --live

pause
