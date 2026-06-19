# Deploy the updated pos_kot_print_online module into Odoo and restart it.
# RUN AS ADMINISTRATOR: right-click -> Run with PowerShell, or:
#   powershell -ExecutionPolicy Bypass -File deploy_kot_module.ps1

$ErrorActionPreference = 'Stop'
$src = 'C:\Users\karth\Downloads\pos_kot_print_online'
$dst = 'C:\Program Files\Odoo 19.0.20260403\server\odoo\addons\pos_kot_print_online'
$svc = 'odoo-server-19.0'
# IMPORTANT: backups go OUTSIDE the addons folder, or Odoo tries to load them as modules.
$backupRoot = 'D:\odoo_module_backups'

if (-not (Test-Path $src)) { Write-Error "Source not found: $src"; exit 1 }

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }
$bak = Join-Path $backupRoot "pos_kot_print_online.$stamp"
Write-Host "1) Backing up current module -> $bak"
if (Test-Path $dst) { Copy-Item $dst $bak -Recurse -Force }

Write-Host "2) Copying updated module files..."
# Copy .py / .xml / .csv (skip caches)
robocopy $src $dst /MIR /XD __pycache__ kotprintimage /XF *.pyc | Out-Null

Write-Host "3) Restarting Odoo service '$svc' (POS offline ~30s)..."
Restart-Service -Name $svc -Force
Start-Sleep -Seconds 5
Write-Host ("   status: {0}" -f (Get-Service -Name $svc).Status)

Write-Host ""
Write-Host "DONE. Now in Odoo:"
Write-Host "  Apps -> search 'KOT' -> KOT Printer Online -> Upgrade"
Write-Host "  Then KOT Setup will show the new 'Type' column."
