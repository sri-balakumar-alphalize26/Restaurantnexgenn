"""Count POS orders, optionally filtered. Used by no-doubling test.

Usage:
  python tools/count_orders.py                 # all orders
  python tools/count_orders.py --since=300     # in last 300 seconds
  python tools/count_orders.py --uuid=<uuid>   # by client_uuid
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

ODOO_URL = "http://localhost:8069"
DB = "res-test1"
USER = "admin"
PWD = "admin"


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
    data, sid = rpc("/web/session/authenticate", {
        "jsonrpc": "2.0",
        "params": {"db": DB, "login": USER, "password": PWD},
    })
    return sid


def main():
    args = {a.split("=", 1)[0].lstrip("-"): (a.split("=", 1)[1] if "=" in a else True)
            for a in sys.argv[1:]}
    sid = auth()

    domain = []
    if "since" in args:
        secs = int(args["since"])
        t = datetime.now(timezone.utc) - timedelta(seconds=secs)
        domain.append(("create_date", ">=", t.strftime("%Y-%m-%d %H:%M:%S")))
    if "uuid" in args:
        domain.append(("client_uuid", "=", args["uuid"]))

    payload = {
        "jsonrpc": "2.0",
        "params": {
            "model": "pos.order", "method": "search_read",
            "args": [domain],
            "kwargs": {"fields": ["id", "name", "client_uuid", "amount_total", "create_date"],
                       "limit": 50, "order": "id desc"},
        },
    }
    data, _ = rpc("/web/dataset/call_kw", payload, sid=sid)
    orders = data.get("result", [])
    print(f"[query] domain={domain}")
    print(f"[count] {len(orders)} order(s)")
    for o in orders:
        print(f"  id={o['id']:<4} name={o['name']:<25}  total={o['amount_total']:>8.3f}  "
              f"client_uuid={o['client_uuid'] or '(none)'}  created={o['create_date']}")


if __name__ == "__main__":
    main()
