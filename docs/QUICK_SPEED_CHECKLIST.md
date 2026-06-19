# NexGenn POS — Quick Speed Checklist

Stopwatch-based manual checks. Walk through each row, tap, time, write actual ms.

| # | Action | Target | Actual | Pass? |
|---|---|---|---|---|
| 1 | Cold launch icon → Welcome Back | < 4 s | | |
| 2 | Warm launch icon → Home | < 3 s | | |
| 3 | Login submit → Home | < 3 s | | |
| 4 | Tap "Take Orders" → POS Register | < 2 s | | |
| 5 | Tap "Continue Selling" → Choose Order Type | < 2 s | | |
| 6 | Tap "Dine In" → Select Table (T1-T12) | < 3 s | | |
| 7 | Tap T2 → POS Products grid | < 4 s cold / < 1 s cached | | |
| 8 | Tap category chip → filtered list | < 1 s | | |
| 9 | Tap product → in cart | < 0.5 s | | |
| 10 | Tap "Pay Now" → payment modal | < 1.5 s | | |
| 11 | Confirm Cash payment → receipt | < 5 s | | |
| 12 | Tap "Kitchen Bill" → KOT preview | < 1 s | | |
| 13 | Print Full Order → printed | < 6 s | | |
| 14 | New Takeout Order flow → products ready | < 4 s | | |
| 15 | Logout → Welcome Back | < 1.5 s | | |
| 16 | Retry (after WiFi back on) → screen loads | < 4 s | | |
| 17 | Search "Bar" → Barotta only | < 0.5 s | | |
| 18 | Bottom nav tab switch | < 0.5 s each | | |
| 19 | EN ↔ AR language switch | < 1 s | | |
| 20 | 50 product taps → memory steady | flat curve | | |

## Field-test scenarios (real-restaurant style)

- [ ] **Single dine-in order** end-to-end < 90 s (login → table → 5 items → pay)
- [ ] **Five concurrent orders** (5 tablets, same session) — no double-orders, all paid
- [ ] **Network drop mid-order** — popup shows, Retry recovers
- [ ] **Print 20 KOTs back-to-back** — no skips, no duplicates
- [ ] **8-hour session** — app still responsive at end of shift
- [ ] **Multi-language** — start in EN, switch to AR, complete order in AR

## When something is slow

1. Note exact step (e.g. `Tap T2 → Products`)
2. Note actual time
3. Take screenshot of slow screen
4. Note: WiFi or USB? Local Odoo or remote? Empty cart or 50 items?
5. Send to dev with all the above.

Source: `tools/generate_test_scenarios.py` rows TC-160 to TC-179. Regenerate via `python tools/generate_test_scenarios.py`.
