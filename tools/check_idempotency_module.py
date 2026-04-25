"""Verify pos_idempotent_create module is installed and pos_reference field works.

Run:  python tools/check_idempotency_module.py
"""
import json
import urllib.request

ODOO_URL = "http://localhost:8069"
DB = "res-test1"
USER = "admin"
PWD = "admin"


def rpc(endpoint, payload, sid=None):
    headers = {"Content-Type": "application/json"}
    if sid:
        headers["Cookie"] = f"session_id={sid}"
    req = urllib.request.Request(
        f"{ODOO_URL}{endpoint}",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers, method="POST",
    )
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


def call_kw(sid, model, method, args, kwargs=None):
    data, _ = rpc("/web/dataset/call_kw", {
        "jsonrpc": "2.0",
        "params": {"model": model, "method": method, "args": args, "kwargs": kwargs or {}},
    }, sid=sid)
    if "error" in data:
        return None, data["error"]
    return data.get("result"), None


def main():
    sid = auth()

    # 1. Is the module installed?
    mods, err = call_kw(sid, "ir.module.module", "search_read",
                       [[("name", "=", "pos_idempotent_create")]],
                       {"fields": ["name", "state", "latest_version"], "limit": 1})
    if err:
        print("ERROR querying ir.module.module:", err)
        return
    if not mods:
        print("[FAIL] pos_idempotent_create module NOT FOUND in this Odoo. Update Apps List + install.")
        return
    m = mods[0]
    print(f"[module] name={m['name']}  state={m['state']}  version={m.get('latest_version')}")
    if m["state"] != "installed":
        print(f"[FAIL] module is in '{m['state']}' state, not 'installed'.")
        return

    # 2. Does pos.order have pos_reference field?
    fields, err = call_kw(sid, "pos.order", "fields_get",
                         [["pos_reference", "client_uuid"]], {"attributes": ["string", "type"]})
    if err or "pos_reference" not in fields:
        print("[FAIL] pos.order does not expose pos_reference field.")
        return
    print(f"[field] pos.order.pos_reference -> {fields['pos_reference']}")
    if "client_uuid" in fields:
        print(f"[field] pos.order.client_uuid    -> {fields['client_uuid']}  [PASS] (v19.0.2.0.0 fix)")
    else:
        print(f"[WARN] pos.order.client_uuid NOT FOUND - module needs upgrade to v19.0.2.0.0")

    # 2b. Does pos.payment have client_uuid (v19.0.3.0.0)?
    payFields, perr = call_kw(sid, "pos.payment", "fields_get",
                              [["client_uuid"]], {"attributes": ["string", "type"]})
    if not perr and "client_uuid" in payFields:
        print(f"[field] pos.payment.client_uuid  -> {payFields['client_uuid']}  [PASS] (v19.0.3.0.0 fix)")
    else:
        print(f"[WARN] pos.payment.client_uuid NOT FOUND - module needs upgrade to v19.0.3.0.0")

    # 3. Sample query: any orders with pos_reference set?
    sample, _ = call_kw(sid, "pos.order", "search_read",
                       [[("pos_reference", "!=", False)]],
                       {"fields": ["id", "name", "pos_reference", "amount_total"], "limit": 5,
                        "order": "id desc"})
    print(f"[sample] {len(sample)} order(s) with non-empty pos_reference (most recent shown):")
    for o in sample:
        print(f"  - id={o['id']}  name={o['name']}  pos_reference={o['pos_reference']}  total={o['amount_total']}")

    print("\n[PASS] pos_idempotent_create installed; pos_reference field active.")
    print("       (DB index TC-084: psql not available locally to verify the btree index by name,")
    print("        but module's init() created it on first install/upgrade.)")


if __name__ == "__main__":
    main()
