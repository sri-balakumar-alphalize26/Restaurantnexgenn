# Fix KOT module conflict: pos_payment_pin (old) shadows pos_kot_print_online (new).
# Removes ONLY the old KOT models from pos_payment_pin (keeps payment_pin), then
# restarts Odoo so pos_kot_print_online becomes the single owner of pos.kot.* .
#
# RUN AS ADMINISTRATOR:  right-click this file -> Run with PowerShell  (accept the UAC prompt)
# or in an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File fix_kot_conflict.ps1

$ErrorActionPreference = 'Stop'
$addon = 'C:\Program Files\Odoo 19.0.20260403\server\odoo\addons\pos_payment_pin'
$svc   = 'odoo-server-19.0'

if (-not (Test-Path $addon)) { Write-Error "pos_payment_pin not found at $addon"; exit 1 }

$initPath = Join-Path $addon 'models\__init__.py'
$csvPath  = Join-Path $addon 'security\ir.model.access.csv'
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

Write-Host "1) Backing up..."
Copy-Item $initPath "$initPath.$stamp.bak" -Force
Copy-Item $csvPath  "$csvPath.$stamp.bak"  -Force

Write-Host "2) Removing old KOT model import (keeps payment_pin / pos_config)..."
# pos_kot_print.py defines the OLD pos.kot.queue + pos.kot.print -> stop importing it.
Set-Content -Path $initPath -Value 'from . import pos_config' -Encoding UTF8

Write-Host "3) Removing old KOT access rules (the models now come from pos_kot_print_online)..."
$csv = @(
  'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink'
)
Set-Content -Path $csvPath -Value $csv -Encoding UTF8

Write-Host "4) Restarting Odoo service '$svc' (POS offline ~30s)..."
Restart-Service -Name $svc -Force
Start-Sleep -Seconds 5
$s = Get-Service -Name $svc
Write-Host ("   Odoo service status: {0}" -f $s.Status)

Write-Host ""
Write-Host "DONE. Next:"
Write-Host "  - In Odoo: Apps -> search 'KOT' / 'payment' -> Upgrade 'pos_payment_pin' (and 'KOT Printer Online')."
Write-Host "  - Open KOT Queue again -> the error_message error should be gone."
