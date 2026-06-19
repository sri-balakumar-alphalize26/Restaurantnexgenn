"""
KOT Print Agent - Cloud Polling
=================================
Polls cloud Odoo server for pending KOT print jobs.
Prints to local thermal printer.

Flow:
    POS Browser → Cloud Odoo (queue) ← This Agent (polls) → Local Printer

Usage:
    pip install requests

    TEST mode (no printer, shows in CMD):
        python print_agent.py

    LIVE mode (sends to real printer):
        python print_agent.py --live

Configuration:
    Edit the settings below or use environment variables.
"""

import socket, json, logging, sys, os, time, requests
from datetime import datetime

def save_kot_image(data):
    """Generate and save a receipt PNG from KOT data (for TEST mode visual check)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        import re as _re

        WIDTH = 576
        MARGIN = 12
        TEXT_W = WIDTH - 2 * MARGIN

        # Find font
        win_fonts = os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts')
        font_big = font_normal = font_small = None
        for fp in [os.path.join(win_fonts, f) for f in ['arial.ttf','tahoma.ttf','calibri.ttf','segoeui.ttf']]:
            if os.path.exists(fp):
                try:
                    font_big = ImageFont.truetype(fp, 48)
                    font_normal = ImageFont.truetype(fp, 36)
                    font_small = ImageFont.truetype(fp, 28)
                    break
                except: pass
        if not font_normal:
            return

        # Try arabic support
        def fix_arabic(text):
            if not text: return ''
            s = str(text)
            if not any('\u0600' <= c <= '\u06FF' for c in s): return s
            try:
                import arabic_reshaper
                from bidi.algorithm import get_display
                return get_display(arabic_reshaper.reshape(s))
            except: return s

        def split_bi(text):
            if not text: return '', None
            s = str(text)
            import re
            m = re.match(r'^(.*?)\s*/\s*(.+)$', s)
            if m:
                eng, ar = m.group(1).strip(), m.group(2).strip()
                if any('\u0600' <= c <= '\u06FF' for c in ar):
                    return eng, ar
            return s.strip(), None

        def measure(font, text):
            try:
                bbox = font.getbbox(text)
                return bbox[2]-bbox[0], bbox[3]-bbox[1]
            except: return font.getsize(text)

        lines = []
        def L(text, font, align='center', bold=False):
            if text: lines.append({'text': str(text), 'font': font, 'align': align, 'bold': bold})
        def SEP():
            lines.append({'sep': True})

        order_type = str(data.get('order_type', '') or 'Dine In')
        now_time = datetime.now().strftime('%I:%M:%S %p')
        if order_type.lower() in ('takeout', 'delivery', 'takeaway'):
            ot_display = '%s (%s)' % (order_type, now_time)
        else:
            ot_display = order_type

        eng_ot, ar_ot = split_bi(ot_display)
        L(eng_ot, font_big, 'center', True)
        if ar_ot: L(fix_arabic(ar_ot), font_big, 'center', True)

        table_name = str(data.get('table_name', '') or '')
        is_dinein = order_type.strip().lower() in ('dine in', 'dinein', 'dine-in')
        if is_dinein and table_name:
            L('Table: ' + table_name, font_big, 'center', True)

        L('Time: ' + datetime.now().strftime('%H:%M'), font_small, 'center')

        slot_time = str(data.get('slot_time', '') or '')
        if slot_time: L('Slot: ' + slot_time, font_small, 'center', True)

        waiter = str(data.get('waiter', '') or data.get('cashier', '') or '')
        if waiter: L('Waiter: ' + waiter, font_small, 'center')

        order_name = str(data.get('order_name', '') or '')
        if order_name:
            eng_on, ar_on = split_bi(order_name)
            if eng_on: L('Order: ' + eng_on, font_small, 'center')
            if ar_on: L(fix_arabic(ar_on), font_small, 'center')

        order_number = str(data.get('order_number', '') or order_name or '')
        order_line = 'Order'
        if not is_dinein and table_name: order_line += ' ' + table_name
        if order_number: order_line += ' # ' + order_number
        L(order_line, font_big, 'center', True)

        guest_count = data.get('guest_count', 0)
        if guest_count: L('Guests: ' + str(guest_count), font_small, 'center')

        SEP()
        print_type = str(data.get('print_type', 'NEW'))
        L('*** ' + print_type + ' ***', font_big, 'center', True)
        SEP()

        items = data.get('items', [])
        if isinstance(items, str):
            try: items = json.loads(items)
            except: items = []
        for item in items:
            name = str(item.get('name', 'Item'))
            qty = int(item.get('qty', 1))
            note = str(item.get('note', '') or '')
            eng_n, ar_n = split_bi(name)
            L('%d  %s' % (qty, eng_n) if eng_n else str(qty), font_normal, 'left', True)
            if ar_n: L(fix_arabic(ar_n), font_normal, 'right', True)
            if note:
                eng_no, ar_no = split_bi(note)
                if eng_no: L('  >> ' + eng_no, font_small, 'left')
                if ar_no: L(fix_arabic(ar_no), font_small, 'right')
        SEP()

        # Measure
        total_h = MARGIN * 2
        for ln in lines:
            if ln.get('sep'): total_h += 18; continue
            _, h = measure(ln['font'], ln['text'])
            total_h += h + 10
        total_h += 60

        # Draw
        img = Image.new('RGB', (WIDTH, total_h), 'white')
        draw = ImageDraw.Draw(img)
        y = MARGIN
        for ln in lines:
            if ln.get('sep'):
                draw.line([(MARGIN, y+8), (WIDTH-MARGIN, y+8)], fill='black', width=2)
                y += 18; continue
            text, font = ln['text'], ln['font']
            try:
                bbox = font.getbbox(text); tw = bbox[2]-bbox[0]; th = bbox[3]-bbox[1]
            except: tw, th = font.getsize(text)
            if ln['align'] == 'center': x = max(MARGIN, (WIDTH-tw)//2)
            elif ln['align'] == 'right': x = max(MARGIN, WIDTH-MARGIN-tw)
            else: x = MARGIN
            draw.text((x, y), text, fill='black', font=font)
            if ln.get('bold'): draw.text((x+1, y), text, fill='black', font=font)
            y += th + 10

        # Save
        save_dir = os.path.join(os.path.expanduser('~'), 'Desktop', 'virtual_prints')
        os.makedirs(save_dir, exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        order_no = str(data.get('order_number') or data.get('order_name') or 'kot')
        order_no = _re.sub(r'[^A-Za-z0-9_-]', '', order_no)[:20] or 'kot'
        png_path = os.path.join(save_dir, 'agent_%s_%s.png' % (ts, order_no))
        img.save(png_path)
        print("  >> Image saved: %s" % png_path)
    except Exception as e:
        print("  (Image save skipped: %s)" % e)

# ============================================
# SETTINGS - Change these for each shop
# ============================================
ODOO_URL = os.getenv("ODOO_URL", "http://115.246.240.218:1489")
ODOO_DB = os.getenv("ODOO_DB", "")  # Set your database name
ODOO_USER = os.getenv("ODOO_USER", "admin")
ODOO_PASS = os.getenv("ODOO_PASS", "admin")

PRINTER_IP = os.getenv("PRINTER_IP", "192.168.0.100")
PRINTER_PORT = int(os.getenv("PRINTER_PORT", "9100"))

POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "2"))  # seconds
# ============================================

LIVE_MODE = "--live" in sys.argv

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("KOT")
kot_count = 0


def odoo_login():
    """Login to Odoo and get session"""
    try:
        session = requests.Session()
        resp = session.post(f"{ODOO_URL}/web/session/authenticate", json={
            "jsonrpc": "2.0",
            "params": {
                "db": ODOO_DB,
                "login": ODOO_USER,
                "password": ODOO_PASS,
            }
        }, timeout=10)
        data = resp.json()
        if data.get('result', {}).get('uid'):
            log.info("Logged in to Odoo as %s (uid=%s)", ODOO_USER, data['result']['uid'])
            return session
        else:
            log.error("Login failed: %s", data.get('error', {}).get('data', {}).get('message', 'Unknown'))
            return None
    except Exception as e:
        log.error("Cannot connect to Odoo: %s", e)
        return None


def odoo_call(session, model, method, args=None):
    """Call Odoo model method via JSON-RPC"""
    try:
        resp = session.post(f"{ODOO_URL}/web/dataset/call_kw", json={
            "jsonrpc": "2.0",
            "method": "call",
            "id": int(time.time()),
            "params": {
                "model": model,
                "method": method,
                "args": args or [],
                "kwargs": {},
            }
        }, timeout=10)
        data = resp.json()
        if data.get('error'):
            log.error("Odoo error: %s", data['error'].get('data', {}).get('message', ''))
            return None
        return data.get('result')
    except Exception as e:
        log.error("RPC error: %s", e)
        return None


def print_to_cmd(data):
    """Show KOT in CMD window"""
    global kot_count
    kot_count += 1

    order_type = data.get('order_type', 'Dine In')
    print_type = data.get('print_type', 'NEW')
    order_number = data.get('order_number', '')
    table_name = data.get('table_name', '')
    waiter = data.get('waiter', '')
    guest_count = data.get('guest_count', 0)
    items = data.get('items', [])
    now = datetime.now().strftime('%d/%m/%Y %H:%M:%S')

    if isinstance(items, str):
        try: items = json.loads(items)
        except: items = []

    print("\n" + "=" * 40)
    print(f"  KOT #{kot_count} RECEIVED")
    print("=" * 40)
    print(f"  *** {print_type} ***")
    print("-" * 40)
    print(f"  {order_type}")
    print(f"  Restaurant : {datetime.now().strftime('%H:%M')}")
    if waiter:      print(f"  Waiter     : {waiter}")
    if table_name:  print(f"  Table      : {table_name}")
    if order_number:print(f"  Order #    : {order_number}")
    if guest_count: print(f"  Guests     : {guest_count}")
    print("-" * 40)

    for item in items:
        name = item.get('name', 'Item')
        qty = item.get('qty', 1)
        note = item.get('note', '')
        print(f"  {qty:<2} {name}")
        if note:
            print(f"     >> {note}")

    print("-" * 40)
    print(f"  Time: {now}")
    print("=" * 40)
    save_kot_image(data)
    print()


def build_receipt(d):
    """Build ESC/POS receipt"""
    INIT = b'\x1b@'; BOLD_ON = b'\x1bE\x01'; BOLD_OFF = b'\x1bE\x00'
    CENTER = b'\x1ba\x01'; LEFT = b'\x1ba\x00'
    DOUBLE = b'\x1d!\x11'; DOUBLE_HEIGHT = b'\x1d!\x01'
    NORMAL = b'\x1d!\x00'; CUT = b'\x1dV\x42\x00'; LF = b'\n'

    data = INIT
    order_type = d.get('order_type', '') or 'Dine In'
    now_time = datetime.now().strftime('%I:%M:%S %p')
    ot = f"{order_type} ({now_time})" if order_type.lower() in ['takeout','delivery','takeaway'] else order_type

    data += CENTER + DOUBLE + BOLD_ON + ot.encode('utf-8', errors='ignore') + LF
    data += NORMAL + BOLD_OFF
    data += ('Restaurant : ' + datetime.now().strftime('%H:%M')).encode('utf-8', errors='ignore') + LF
    waiter = d.get('waiter', '') or d.get('cashier', '')
    if waiter: data += ('Waiter: ' + str(waiter)).encode('utf-8', errors='ignore') + LF
    data += LF

    table_name = d.get('table_name', '')
    order_number = d.get('order_number', '') or d.get('order_name', '')
    ol = 'Order'
    if table_name: ol += ' ' + str(table_name)
    if order_number: ol += ' # ' + str(order_number)
    data += BOLD_ON + DOUBLE_HEIGHT + ol.encode('utf-8', errors='ignore') + LF + NORMAL + BOLD_OFF

    gc = d.get('guest_count', 0)
    if gc: data += ('Guest: ' + str(gc)).encode('utf-8', errors='ignore') + LF
    data += LF + b'-' * 32 + LF

    pt = d.get('print_type', 'NEW')
    data += CENTER + BOLD_ON + DOUBLE + pt.encode('utf-8', errors='ignore') + LF
    data += NORMAL + BOLD_OFF + LEFT + b'-' * 32 + LF

    items = d.get('items', [])
    if isinstance(items, str):
        try: items = json.loads(items)
        except: items = []
    for item in items:
        line = '{:<2} {}'.format(int(item.get('qty', 1)), str(item.get('name', 'Item')))
        data += BOLD_ON + line.encode('utf-8', errors='ignore') + LF + BOLD_OFF
        if item.get('note'):
            data += ('   >> ' + str(item['note'])).encode('utf-8', errors='ignore') + LF

    data += LF + b'-' * 32 + LF * 9 + CUT
    return data


def send_to_printer(raw, ip=None, port=None):
    ip = ip or PRINTER_IP; port = port or PRINTER_PORT
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5); s.connect((str(ip), int(port)))
        s.sendall(raw); s.shutdown(socket.SHUT_WR); s.close()
        log.info("Printed to %s:%s", ip, port)
        return True, "OK"
    except Exception as e:
        log.error("Print failed %s:%s - %s", ip, port, e)
        return False, str(e)


def get_db_list():
    """Get available databases from Odoo"""
    try:
        resp = requests.post(f"{ODOO_URL}/web/database/list", json={
            "jsonrpc": "2.0", "params": {}
        }, timeout=10)
        data = resp.json()
        return data.get('result', [])
    except:
        return []


def run():
    global ODOO_DB
    print("")
    print("=" * 50)
    print("  KOT Printer Online (Agent)")
    print("=" * 50)
    print(f"  Odoo    : {ODOO_URL}")
    print(f"  DB      : {ODOO_DB or '(auto-detect)'}")
    print(f"  User    : {ODOO_USER}")
    print(f"  Printer : {PRINTER_IP}:{PRINTER_PORT}")
    print(f"  Mode    : {'LIVE' if LIVE_MODE else 'TEST (CMD only)'}")
    print(f"  Poll    : Every {POLL_INTERVAL}s")
    print("=" * 50)

    # Auto-detect DB if not set
    if not ODOO_DB:
        dbs = get_db_list()
        if len(dbs) == 1:
            ODOO_DB = dbs[0]
            log.info("Auto-detected DB: %s", ODOO_DB)
        elif len(dbs) > 1:
            print(f"\n  Multiple databases found: {dbs}")
            print(f"  Set ODOO_DB in install.bat or as env variable")
            print(f"  Example: set ODOO_DB={dbs[0]}\n")
            ODOO_DB = input("  Enter database name: ").strip()
            if not ODOO_DB:
                print("  No DB selected, exiting.")
                sys.exit(1)
        else:
            print("\n  Could not detect databases. Set ODOO_DB manually.")
            ODOO_DB = input("  Enter database name: ").strip()

    # Login
    print(f"\n  Connecting to {ODOO_URL} (db: {ODOO_DB})...")
    session = odoo_login()
    if not session:
        print("\n  Failed to login! Check URL/DB/user/password.")
        print(f"  URL:  {ODOO_URL}")
        print(f"  DB:   {ODOO_DB}")
        print(f"  User: {ODOO_USER}")
        input("\n  Press Enter to exit...")
        sys.exit(1)

    print(f"\n  Connected! Polling for KOT jobs...\n")

    # Poll loop
    errors = 0
    while True:
        try:
            # Get pending KOTs
            result = odoo_call(session, 'pos.kot.queue', 'get_pending', [PRINTER_IP])

            if result is None:
                errors += 1
                if errors > 5:
                    log.warning("Too many errors, re-authenticating...")
                    session = odoo_login()
                    errors = 0
                time.sleep(POLL_INTERVAL)
                continue

            errors = 0

            if not result:
                # No pending KOTs
                time.sleep(POLL_INTERVAL)
                continue

            # Process each KOT
            done_ids = []
            failed_ids = []

            for kot in result:
                kot_id = kot.get('id')
                kot_data = kot.get('data', {})

                if not kot_data.get('items'):
                    done_ids.append(kot_id)
                    continue

                # Show in CMD
                print_to_cmd(kot_data)

                if LIVE_MODE:
                    # Send to printer
                    ip = kot_data.get('printer_ip', PRINTER_IP)
                    port = kot_data.get('printer_port', PRINTER_PORT)
                    ok, msg = send_to_printer(build_receipt(kot_data), ip, port)
                    if ok:
                        done_ids.append(kot_id)
                    else:
                        failed_ids.append(kot_id)
                        log.error("Print failed for KOT #%s: %s", kot_id, msg)
                else:
                    # Test mode - mark as done
                    done_ids.append(kot_id)

            # Mark as done/failed
            if done_ids:
                odoo_call(session, 'pos.kot.queue', 'mark_done', [done_ids])
            if failed_ids:
                odoo_call(session, 'pos.kot.queue', 'mark_failed', [failed_ids])

        except KeyboardInterrupt:
            print("\n  Stopped.")
            break
        except Exception as e:
            log.error("Poll error: %s", e)
            errors += 1

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run()
