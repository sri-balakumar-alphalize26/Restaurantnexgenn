/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";

// GLOBAL STORAGE
if (typeof window.KOT_DATA === 'undefined') {
    window.KOT_DATA = {};
}

patch(ControlButtons.prototype, {
    setup() {
        super.setup(...arguments);
    },

    _key() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        return o?.uid || o?.id || o?.name || "x";
    },

    _store() {
        const k = this._key();
        if (!window.KOT_DATA[k]) {
            // p:  has KOT been printed at least once for this order
            // qs: { itemId: alreadySentQty }  — how much qty was already printed per line
            // t:  cached table name
            window.KOT_DATA[k] = { p: false, qs: {}, t: "" };
        }
        // Backwards compat: convert old `s: [ids...]` into qs (treat each id as fully sent)
        if (window.KOT_DATA[k].s && !window.KOT_DATA[k].qs) {
            const qs = {};
            (window.KOT_DATA[k].s || []).forEach(id => { qs[id] = Number.MAX_SAFE_INTEGER; });
            window.KOT_DATA[k].qs = qs;
            delete window.KOT_DATA[k].s;
        }
        return window.KOT_DATA[k];
    },

    _table() {
        const st = this._store();
        if (st.t) return st.t;
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        let n = "";
        try { n = o?.table_id?.name || ""; } catch(e){}
        if (!n) try { n = o?.table_id?.getName?.() || ""; } catch(e){}
        if (!n) try { for(let k in o?.table_id){if(k==='name'){n=o.table_id[k];break;}} } catch(e){}
        if (!n) try { n = this.pos.selectedTable?.name || ""; } catch(e){}
        if (n) { st.t = String(n); }
        return st.t;
    },

    _type() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        try { return o?.preset_id?.name || "Dine In"; } catch(e){ return "Dine In"; }
    },

    _guests() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        return o?.guest_count || 0;
    },

    _num() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        const r = o?.pos_reference || o?.name || "";
        const p = r.split('-');
        return p.length ? String(parseInt(p[p.length-1]) || "") : "";
    },

    _orderName() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        return o?.floating_order_name || "";
    },

    _slotTime() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        try {
            const pt = o?.preset_time;
            if (!pt) return "";
            // preset_time is a Luxon DateTime object
            if (typeof pt === 'object' && typeof pt.toFormat === 'function') {
                return pt.toFormat('dd/MM/yyyy HH:mm');
            }
            // fallback: JS Date or ISO string
            const d = new Date(pt);
            if (!isNaN(d.getTime())) {
                const dd = String(d.getDate()).padStart(2,'0');
                const mm = String(d.getMonth()+1).padStart(2,'0');
                const yyyy = d.getFullYear();
                const hh = String(d.getHours()).padStart(2,'0');
                const min = String(d.getMinutes()).padStart(2,'0');
                return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
            }
            return String(pt);
        } catch(e) { return ""; }
    },

    _waiter() {
        let waiter = "";
        try { if (this.pos.user?.name) waiter = this.pos.user.name; } catch(e){}
        if (!waiter) try { const c = this.pos.get_cashier?.(); if (c?.name) waiter = c.name; } catch(e){}
        if (!waiter) try { if (this.pos.cashier?.name) waiter = this.pos.cashier.name; } catch(e){}
        if (!waiter) try { if (this.pos.employee?.name) waiter = this.pos.employee.name; } catch(e){}
        if (!waiter) try { if (this.pos.session?.user_id?.name) waiter = this.pos.session.user_id.name; } catch(e){}
        return waiter;
    },

    _iid(line, i) {
        let pid = "";
        try { pid = typeof line.get_product==='function' ? (line.get_product()?.id||"") : (line.product_id?.id||""); } catch(e){}
        return `${line.id||line.cid||i}_${pid}`;
    },

    _items() {
        const st = this._store();
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;

        let lines = [];
        try { lines = typeof o?.get_orderlines==='function' ? o.get_orderlines() : (o?.lines||o?.orderlines||[]); } catch(e){}

        const arr = [];
        if (lines?.forEach) lines.forEach(l => arr.push(l));

        return arr.map((line, i) => {
            const id = this._iid(line, i);
            let name = "Item", qty = 1;
            try { const p = typeof line.get_product==='function' ? line.get_product() : line.product_id; name = p?.display_name || p?.name || "Item"; } catch(e){}
            try { qty = typeof line.get_quantity==='function' ? line.get_quantity() : (line.qty||1); } catch(e){}

            // Parse Odoo 19 JSON note format
            let note = "";
            const rawNote = line.customer_note || line.note || "";
            if (rawNote) {
                try {
                    const parsed = typeof rawNote === 'string' ? JSON.parse(rawNote) : rawNote;
                    if (Array.isArray(parsed)) {
                        note = parsed.map(n => n.text || n).filter(Boolean).join(', ');
                    } else if (typeof parsed === 'object' && parsed.text) {
                        note = parsed.text;
                    } else {
                        note = String(rawNote);
                    }
                } catch (e) {
                    note = String(rawNote);
                }
            }

            let categoryId = null;
            try {
                const p = typeof line.get_product === 'function' ? line.get_product() : line.product_id;
                // Odoo 19: product.template field is `pos_categ_ids` (plural, "categ" not "category")
                categoryId = p?.pos_categ_ids?.[0]?.id
                    || p?.pos_category_id?.id
                    || null;
            } catch(e) {}

            const totalQty = Number(qty) || 1;
            const sentQty = Number(st.qs[id] || 0);
            const newQty = Math.max(0, totalQty - sentQty);

            return {
                id, name: String(name),
                qty: totalQty,
                newQty,
                note: note,
                sent: newQty <= 0,
                category_id: categoryId,
            };
        });
    },

    _buildPayload(type, items) {
        const cfg = this.pos.config;
        return {
            config_id: cfg.id || false,
            order_type: this._type(),
            table_name: this._table(),
            order_number: this._num(),
            guest_count: this._guests(),
            waiter: this._waiter(),
            print_type: type,
            order_name: this._orderName(),
            slot_time: this._slotTime(),
            items: items.map(i => ({ name: i.name, qty: i.qty, note: i.note || '', category_id: i.category_id || null })),
        };
    },

    // Send to Odoo server (queues for agent to pick up)
    async _send(type, items) {
        const payload = this._buildPayload(type, items);
        const table = this._table();
        const waiter = this._waiter();

        console.log("=== SENDING KOT ===", type, items.length, "items");

        try {
            const resp = await fetch('/web/dataset/call_kw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'call',
                    id: Date.now(),
                    params: {
                        model: 'pos.kot.print',
                        method: 'print_kot',
                        args: [payload],
                        kwargs: {},
                    },
                }),
            });
            const data = await resp.json();

            if (data.error) {
                alert("✗ " + (data.error.data?.message || 'Server error'));
                return false;
            }

            const res = data.result || {};
            if (res.success) {
                alert("✓ KOT [" + type + "]\n" + this._type() + (table ? " - " + table : "") +
                      "\nWaiter: " + waiter + "\nItems: " + items.length);
                return true;
            }

            alert("✗ " + (res.message || "Failed"));
            return false;
        } catch (err) {
            alert("✗ Error: " + err.message);
            return false;
        }
    },

    // Item-selection dialog. Shows a checkbox list with all items pre-checked.
    // User unchecks any line they don't want to print, then clicks OK.
    // Resolves to an array of selected item objects (or null on cancel).
    _kotSelectDialog(items) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'kot-dialog-overlay';

            const box = document.createElement('div');
            box.className = 'kot-dialog-box kot-dialog-box-select';

            const title = document.createElement('div');
            title.className = 'kot-dialog-title';
            title.textContent = 'KOT — Select items to print';
            box.appendChild(title);

            // Quick toggles
            const toggleRow = document.createElement('div');
            toggleRow.className = 'kot-toggle-row';
            const toggleAllBtn = document.createElement('button');
            toggleAllBtn.className = 'kot-toggle-btn';
            toggleAllBtn.textContent = 'Select all';
            const toggleNewBtn = document.createElement('button');
            toggleNewBtn.className = 'kot-toggle-btn';
            toggleNewBtn.textContent = 'Only new items';
            const clearAllBtn = document.createElement('button');
            clearAllBtn.className = 'kot-toggle-btn';
            clearAllBtn.textContent = 'Clear';
            toggleRow.appendChild(toggleAllBtn);
            toggleRow.appendChild(toggleNewBtn);
            toggleRow.appendChild(clearAllBtn);
            box.appendChild(toggleRow);

            // Item list
            const list = document.createElement('div');
            list.className = 'kot-select-list';

            const rows = items.map(item => {
                const row = document.createElement('label');
                row.className = 'kot-item-row';
                if (item.newQty > 0) row.classList.add('kot-item-row-new');

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;   // default: all selected
                cb.className = 'kot-item-cb';

                const qty = document.createElement('span');
                qty.className = 'kot-item-qty';
                qty.textContent = item.qty + 'x';

                const name = document.createElement('span');
                name.className = 'kot-item-name';
                name.textContent = item.name;

                const tag = document.createElement('span');
                tag.className = 'kot-item-tag';
                if (item.newQty > 0) tag.textContent = '+' + item.newQty + ' new';
                else tag.textContent = 'sent';

                row.appendChild(cb);
                row.appendChild(qty);
                row.appendChild(name);
                row.appendChild(tag);
                list.appendChild(row);
                return { row, cb, item };
            });
            box.appendChild(list);

            // Action buttons
            const btnRow = document.createElement('div');
            btnRow.className = 'kot-dialog-btns';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'kot-btn kot-btn-cancel';
            cancelBtn.innerHTML = '<div class="kot-btn-label">Cancel</div>';

            const okBtn = document.createElement('button');
            okBtn.className = 'kot-btn kot-btn-ok';
            okBtn.innerHTML = '<div class="kot-btn-label">Print Selected</div>';

            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(okBtn);
            box.appendChild(btnRow);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'kot-dialog-close';
            closeBtn.textContent = '×';
            box.appendChild(closeBtn);

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const finish = (selected) => {
                document.body.removeChild(overlay);
                document.removeEventListener('keydown', onKey);
                resolve(selected);
            };
            const onKey = (e) => { if (e.key === 'Escape') finish(null); };
            document.addEventListener('keydown', onKey);

            toggleAllBtn.addEventListener('click', () => rows.forEach(r => { r.cb.checked = true; }));
            toggleNewBtn.addEventListener('click', () => rows.forEach(r => { r.cb.checked = (r.item.newQty > 0); }));
            clearAllBtn.addEventListener('click', () => rows.forEach(r => { r.cb.checked = false; }));

            cancelBtn.addEventListener('click', () => finish(null));
            closeBtn.addEventListener('click', () => finish(null));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });

            okBtn.addEventListener('click', () => {
                const chosen = rows.filter(r => r.cb.checked).map(r => r.item);
                finish(chosen);
            });
        });
    },

    // Mark items as sent up to their current qty (or just the diff for NEW prints)
    _markSent(st, lines, mode) {
        lines.forEach(i => {
            if (mode === 'full') {
                // FULL: everything is now considered sent up to its current qty
                st.qs[i.id] = i.qty;
            } else {
                // NEW: bump the sent qty by what was newly printed (which equals i.newQty if printed)
                st.qs[i.id] = (st.qs[i.id] || 0) + (i.newQty || 0);
            }
        });
    },

    // Build the payload-friendly subset for a NEW print: same shape as items but qty=newQty
    _buildNewPayload(newItems) {
        return newItems
            .filter(i => i.newQty > 0)
            .map(i => ({ ...i, qty: i.newQty }));
    },

    async onClickKotPrint() {
        const o = this.pos.get_order ? this.pos.get_order() : this.pos.selectedOrder;
        if (!o) { alert("No order"); return; }

        const st = this._store();
        const items = this._items();
        if (!items.length) { alert("No items"); return; }

        const newItems = items.filter(i => i.newQty > 0);

        // FIRST TIME — auto-print full order, no dialog
        if (!st.p) {
            st.p = true;
            this._markSent(st, items, 'full');
            await this._send("NEW", items);
            return;
        }

        // SUBSEQUENT PRESS — open selection dialog (all items pre-checked)
        const chosen = await this._kotSelectDialog(items);
        if (!chosen || !chosen.length) return;   // cancelled or nothing selected

        // If everything in the order is checked → treat as full reprint.
        // If only the new-item lines are checked → NEW print of just the diff.
        // Mixed → manual selection: send selected lines as a "FULL" type,
        // and mark them sent up to their full qty so they don't reappear as new.
        const allChecked = chosen.length === items.length;
        const onlyNew = chosen.length === newItems.length &&
                        chosen.every(c => c.newQty > 0);

        if (onlyNew) {
            const payload = this._buildNewPayload(chosen);
            this._markSent(st, chosen, 'new');
            await this._send("NEW", payload);
        } else {
            // Mark all chosen lines as fully-sent so they're no longer "new"
            this._markSent(st, chosen, 'full');
            await this._send(allChecked ? "FULL" : "PARTIAL", chosen);
        }
    },
});
