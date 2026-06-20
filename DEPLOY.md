# NexGenn POS — Deployment Guide

Agent-free network printing (KOT + receipt + invoice) from the app, local + cloud.

## What's in this repo
| Path | What |
|---|---|
| `odoo_module/pos_kot_print_online/` | Odoo module — KOT/receipt/invoice, category routing, branded template via `dynamic_invoice_template` → PDF → image |
| `src/` | React Native app (auto-print on Pay Now, local/online delivery, device archive) |
| `tools/vprinter.py` | Virtual printer for testing without hardware (TCP 9100 → saves PNG) |
| `tools/fake_printer.js` | Same, Node version |
| `tools/deploy_kot_module.ps1` / `fix_kot_conflict.ps1` | Windows deploy/fix scripts |
| `release/nexgenn-pos.apk` | Built standalone APK (not in git; copy locally) |

---

## A. Odoo server (Ubuntu)

### 1. Modules
- **`pos_kot_print_online`** — copy `odoo_module/pos_kot_print_online` into your addons path, then install/upgrade.
- **`dynamic_invoice_template`** — must be installed (renders the branded receipt).
- **`pos_payment_pin`** — if installed, remove its old KOT models (it also defines `pos.kot.print`/`pos.kot.queue` and conflicts). Keep only its `payment_pin`. Then upgrade it.

### 2. Python libraries (into Odoo's python/venv)
```bash
sudo -H pip3 install pymupdf Pillow arabic-reshaper python-bidi
sudo apt-get install -y libraqm0      # better Arabic shaping (optional)
```

### 3. Deploy + update
```bash
sudo cp -r odoo_module/pos_kot_print_online /opt/odoo/custom-addons/
sudo chown -R odoo: /opt/odoo/custom-addons/pos_kot_print_online
sudo systemctl stop odoo
sudo -u odoo /opt/odoo/odoo-bin -c /etc/odoo/odoo.conf \
  -d YOUR_DB -u pos_kot_print_online,pos_payment_pin --stop-after-init
sudo systemctl start odoo
```
Or via UI: **Apps → Update Apps List → Upgrade** `pos_kot_print_online`.

### 4. Configure
- **KOT Setup**: add printers — IP, port 9100, **Type** (Kitchen/Receipt/Invoice/Counter), categories.
- **Invoice Template**: **POS Receipt Layout = `engine_template`** (server-renderable; `default`/`watch_pos` are browser-only and fall back to the simple layout).
- **kot_use_queue (Online Mode)**: OFF if Odoo is on the shop LAN (Odoo prints directly); the APK delivers itself when Odoo is cloud.

---

## B. App (APK)
- Install `release/nexgenn-pos.apk` on the tablet (standalone — no Metro).
- Device Setup → enter the Odoo URL (local IP or cloud domain), DB, admin login.
- Pay Now → receipt auto-prints to the Counter printer; KOT via Kitchen Bill.

### Flows
- **Local Odoo** (on shop LAN): Odoo prints directly to the printer IP.
- **Cloud Odoo**: app sends to cloud → cloud renders image → app delivers to the local printer IP over the LAN. **No agent.** (Tablet + printer must share the router.)
- **Web + cloud**: browser can't reach a local printer — needs the tablet-app gateway or a PC agent.

---

## C. Testing without a real printer
On a PC on the **same router/Wi-Fi as the tablet**:
```bash
python tools/vprinter.py          # listens on 9100, prints its IP
pip install pillow                # to auto-decode receipts to PNG
```
Set KOT Setup printer IP = that PC's local IP, port 9100. Print from the app → a PNG appears in `vprints/` (open to view).
