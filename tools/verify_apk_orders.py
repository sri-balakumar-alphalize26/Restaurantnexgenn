"""APK -> Odoo data integrity cross-check.

Pulls the most recent N pos.order records from Odoo and validates each one
against what the APK should have sent. Use this AFTER an APK test session
to confirm the APK's outbound data is correct.

Usage:
  python tools/verify_apk_orders.py                 # default: last 10 orders
  python tools/verify_apk_orders.py --last=5
  python tools/verify_apk_orders.py --since=600     # last 10 minutes
  python tools/verify_apk_orders.py --duplicates    # show client_uuid dupes
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

ODOO_URL = "http://localhost:8069"
DB = "res-test1"
USER = "admin"
PWD = "admin"

UUID_RE_PATTERN = (
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)


def rpc(endpoint, payload, sid=None):
    headers = {"Content-Type": "application/json"}
    if sid:
        headers["Cookie"] = f"session_id={sid}"
    req = urllib.request.Request(f"{ODOO_URL}{endpoint}",
                                 data=json.dumps(payload).encode(),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        cookie = r.headers.get("Set-Cookie", "")
        new_sid = cookie.split("session_id=", 1)[1].split(";", 1)[0] if "session_id=" in cookie else None
        return json.loads(r.read()), new_sid


def auth():
    data, _ = rpc("/web/session/authenticate", {
        "jsonrpc": "2.0",
        "params": {"db": DB, "login": USER, "password": PWD},
    })
    if not data.get("result", {}).get("uid"):
        raise SystemExit(f"Auth failed: {data}")
    # Re-call to get the cookie reliably
    _, sid = rpc("/web/session/authenticate", {
        "jsonrpc": "2.0",
        "params": {"db": DB, "login": USER, "password": PWD},
    })
    return sid


def call_kw(sid, model, method, args, kwargs=None):
    payload = {
        "jsonrpc": "2.0",
        "params": {"model": model, "method": method, "args": args, "kwargs": kwargs or {}},
    }
    data, _ = rpc("/web/dataset/call_kw", payload, sid=sid)
    if "error" in data:
        raise SystemExit(f"RPC error: {json.dumps(data['error'], indent=2)[:600]}")
    return data.get("result")


def fmt_check(ok, msg):
    return f"  {'[PASS]' if ok else '[FAIL]'} {msg}"


def is_v4_uuid(s):
    import re
    return bool(s and re.match(UUID_RE_PATTERN, s, re.IGNORECASE))


def verify_order(sid, o):
    print(f"\nOrder #{o['id']} name={o['name']}")
    print(f"  total={o.get('amount_total'):.3f} OMR  state={o.get('state')}  "
          f"created={o.get('create_date')}")
    print(f"  client_uuid = {o.get('client_uuid') or '(none)'}")
    print(f"  pos_reference = {o.get('pos_reference')}")
    issues = []

    # 1. client_uuid must be a v4 UUID for orders created with new APK
    if o.get('client_uuid'):
        if is_v4_uuid(o['client_uuid']):
            print(fmt_check(True, "client_uuid is valid v4 UUID"))
        else:
            print(fmt_check(False, f"client_uuid is NOT a valid v4 UUID: {o['client_uuid']}"))
            issues.append('uuid-format')
    else:
        print(fmt_check(False, "client_uuid is empty (old APK or pre-fix)"))
        issues.append('no-uuid')

    # 2. amount_total > 0 (sanity)
    if o.get('amount_total', 0) <= 0:
        print(fmt_check(False, f"amount_total is zero or negative ({o.get('amount_total')})"))
        issues.append('zero-total')

    # 3. lines exist and add up correctly
    if o.get('lines'):
        line_ids = o['lines']
        lines = call_kw(sid, "pos.order.line", "read", [line_ids],
                        {"fields": ["id", "product_id", "qty", "price_unit",
                                    "price_subtotal", "price_subtotal_incl"]})
        line_subtotal = sum(l.get('price_subtotal_incl') or 0 for l in lines)
        print(f"  lines ({len(lines)}):")
        for l in lines:
            pname = l['product_id'][1] if isinstance(l.get('product_id'), list) else '?'
            print(f"    - qty={l['qty']:>3}  price_unit={l['price_unit']:>7.3f}  "
                  f"subtotal_incl={l['price_subtotal_incl']:>7.3f}  product={pname}")
        if abs(line_subtotal - o['amount_total']) > 0.01:
            print(fmt_check(False,
                f"sum(line.price_subtotal_incl) {line_subtotal:.3f} != "
                f"amount_total {o['amount_total']:.3f}"))
            issues.append('line-sum-mismatch')
        else:
            print(fmt_check(True, f"line totals reconcile to amount_total ({line_subtotal:.3f} OMR)"))
    else:
        print(fmt_check(False, "no order lines on this order"))
        issues.append('no-lines')

    return issues


def main():
    args = {a.split("=", 1)[0].lstrip("-"): (a.split("=", 1)[1] if "=" in a else True)
            for a in sys.argv[1:]}
    sid = auth()

    domain = []
    if "since" in args:
        secs = int(args["since"])
        t = datetime.now(timezone.utc) - timedelta(seconds=secs)
        domain.append(("create_date", ">=", t.strftime("%Y-%m-%d %H:%M:%S")))

    last = int(args.get("last", 10)) if not args.get("last") is True else 10

    orders = call_kw(sid, "pos.order", "search_read",
                     [domain],
                     {"fields": ["id", "name", "client_uuid", "pos_reference",
                                 "amount_total", "state", "create_date", "lines"],
                      "limit": last, "order": "id desc"})

    print(f"=== APK -> Odoo cross-check  ({len(orders)} orders) ===")
    if not orders:
        print("No orders found — make sure the APK has paid at least one cart.")
        return

    total_issues = []
    uuid_seen = {}
    for o in orders:
        issues = verify_order(sid, o)
        total_issues.extend(issues)
        u = o.get('client_uuid')
        if u:
            uuid_seen.setdefault(u, []).append(o['id'])

    # Duplicate detection
    dups = {u: ids for u, ids in uuid_seen.items() if len(ids) > 1}
    print("\n=== Idempotency check ===")
    if dups:
        print(f"[FAIL] {len(dups)} duplicate client_uuid value(s) found — dedup did NOT work:")
        for u, ids in dups.items():
            print(f"  uuid={u}  -> orders {ids}")
    else:
        print("[PASS] No duplicate client_uuid values across orders — dedup OK.")

    print("\n=== Summary ===")
    print(f"  Orders inspected: {len(orders)}")
    print(f"  Issues:           {len(total_issues)}")
    if total_issues:
        print(f"  Issue types:      {sorted(set(total_issues))}")
    if dups or total_issues:
        sys.exit(1)


if __name__ == "__main__":
    main()
