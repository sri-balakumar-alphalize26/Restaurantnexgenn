"""Configure local Odoo at localhost:8069 with Oman / OMR settings + seed restaurant POS products.

Run:  python tools/setup_oman_pos.py
"""
import json
import sys
import urllib.request

ODOO_URL = "http://localhost:8069"
DB = "res-test1"
USER = "admin"
PWD = "admin"


def rpc(endpoint, payload, session_id=None):
    headers = {"Content-Type": "application/json"}
    if session_id:
        headers["Cookie"] = f"session_id={session_id}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{ODOO_URL}{endpoint}", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        sid = None
        cookie = resp.headers.get("Set-Cookie", "")
        if "session_id=" in cookie:
            sid = cookie.split("session_id=", 1)[1].split(";", 1)[0]
        data = json.loads(resp.read().decode("utf-8"))
        return data, sid


def auth():
    data, sid = rpc("/web/session/authenticate", {
        "jsonrpc": "2.0",
        "params": {"db": DB, "login": USER, "password": PWD},
    })
    if not data.get("result", {}).get("uid"):
        raise SystemExit(f"Auth failed: {data}")
    print(f"[auth] uid={data['result']['uid']} session={sid[:12]}...")
    return sid, data["result"]["uid"], data["result"].get("company_id", 1)


def call_kw(sid, model, method, args, kwargs=None):
    payload = {
        "jsonrpc": "2.0",
        "params": {
            "model": model,
            "method": method,
            "args": args,
            "kwargs": kwargs or {},
        },
    }
    data, _ = rpc("/web/dataset/call_kw", payload, session_id=sid)
    if "error" in data:
        raise SystemExit(f"call_kw error on {model}.{method}: {json.dumps(data['error'], indent=2)[:500]}")
    return data.get("result")


def main():
    sid, uid, company_id = auth()
    print(f"[start] company_id={company_id}")

    # ------ 1. Activate OMR currency ------
    omr = call_kw(sid, "res.currency", "search_read",
                  [[("name", "=", "OMR")]],
                  {"fields": ["id", "name", "active", "decimal_places", "rounding"], "limit": 1})
    if not omr:
        raise SystemExit("res.currency record for OMR not found in this Odoo. Currency master is missing.")
    omr_id = omr[0]["id"]
    if not omr[0]["active"]:
        call_kw(sid, "res.currency", "write", [[omr_id], {"active": True}])
        print(f"[OMR] activated currency id={omr_id}")
    else:
        print(f"[OMR] already active id={omr_id}")
    # Ensure 3-decimal precision for OMR (Baisa)
    call_kw(sid, "res.currency", "write",
            [[omr_id], {"decimal_places": 3, "rounding": 0.001}])
    print(f"[OMR] decimal_places=3 rounding=0.001")

    # ------ 2. Set company currency to OMR ------
    call_kw(sid, "res.company", "write", [[company_id], {"currency_id": omr_id}])
    print(f"[company] currency_id -> OMR")

    # ------ 3. Configure 5% Oman VAT ------
    tax = call_kw(sid, "account.tax", "search_read",
                  [[("name", "ilike", "5%"), ("type_tax_use", "=", "sale")]],
                  {"fields": ["id", "name", "amount", "price_include"], "limit": 1})
    if tax:
        tax_id = tax[0]["id"]
        call_kw(sid, "account.tax", "write",
                [[tax_id], {"amount": 5.0, "name": "VAT 5% (Oman)",
                            "type_tax_use": "sale",
                            # Tax-inclusive prices: list_price already contains the 5% tax
                            "price_include_override": "tax_included"}])
        print(f"[tax] updated existing tax id={tax_id} to 5% Oman VAT (tax-inclusive)")
    else:
        # Try to find any 15% tax to repurpose
        existing = call_kw(sid, "account.tax", "search_read",
                           [[("type_tax_use", "=", "sale")]],
                           {"fields": ["id", "name", "amount"], "limit": 5})
        if existing:
            tax_id = existing[0]["id"]
            call_kw(sid, "account.tax", "write",
                    [[tax_id], {"amount": 5.0, "name": "VAT 5% (Oman)"}])
            print(f"[tax] repurposed tax id={tax_id} ({existing[0]['name']}) -> 5% Oman VAT")
        else:
            tax_id = call_kw(sid, "account.tax", "create", [{
                "name": "VAT 5% (Oman)",
                "amount": 5.0,
                "type_tax_use": "sale",
                "amount_type": "percent",
                "company_id": company_id,
            }])
            print(f"[tax] created new tax id={tax_id} 5% Oman VAT")

    # ------ 4. Find / create POS categories ------
    def upsert_pos_category(name):
        rec = call_kw(sid, "pos.category", "search_read",
                      [[("name", "=", name)]], {"fields": ["id"], "limit": 1})
        if rec:
            return rec[0]["id"]
        return call_kw(sid, "pos.category", "create", [{"name": name}])

    food_cat = upsert_pos_category("Food")
    drinks_cat = upsert_pos_category("Drinks")
    print(f"[pos.category] Food={food_cat}  Drinks={drinks_cat}")

    # ------ 5. Seed restaurant products in OMR ------
    products = [
        ("Barotta",     1.000,  food_cat),
        ("Fried Rice",  4.000,  food_cat),
        ("Chicken Biryani", 3.500, food_cat),
        ("Mandi",       5.000,  food_cat),
        ("Shawarma",    1.500,  food_cat),
        ("Hummus",      2.000,  food_cat),
        ("Karak Tea",   0.500,  drinks_cat),
        ("Arabic Coffee", 0.750, drinks_cat),
        ("Mango Juice", 1.000,  drinks_cat),
        ("Fresh Lime",  0.500,  drinks_cat),
        ("Soft Drink",  0.500,  drinks_cat),
    ]

    for name, price, pos_categ_id in products:
        existing = call_kw(sid, "product.template", "search_read",
                           [[("name", "=", name)]],
                           {"fields": ["id"], "limit": 1})
        vals = {
            "name": name,
            "list_price": price,
            "type": "consu",  # consumable
            "available_in_pos": True,
            "taxes_id": [(6, 0, [tax_id])],
            "pos_categ_ids": [(6, 0, [pos_categ_id])],
        }
        if existing:
            tmpl_id = existing[0]["id"]
            call_kw(sid, "product.template", "write", [[tmpl_id], vals])
            print(f"[product] updated {name:20s} {price:>7.3f} OMR  (tmpl={tmpl_id})")
        else:
            tmpl_id = call_kw(sid, "product.template", "create", [vals])
            print(f"[product] CREATED {name:20s} {price:>7.3f} OMR  (tmpl={tmpl_id})")

    # ------ 6. Find pos.config and ensure currency / pricing context is consistent ------
    cfgs = call_kw(sid, "pos.config", "search_read",
                   [[]], {"fields": ["id", "name", "currency_id"], "limit": 5})
    print(f"[pos.config] {len(cfgs)} configs:")
    for c in cfgs:
        print(f"  - id={c['id']:<3}  name={c['name']:<30}  currency={c['currency_id']}")

    print("\n[DONE] Local Odoo configured for Oman / OMR with seeded restaurant menu.")
    print("       Refresh the POS UI in browser to pick up changes.")


if __name__ == "__main__":
    main()
