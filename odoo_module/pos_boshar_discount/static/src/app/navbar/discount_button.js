/** @odoo-module **/

import { Component, useState, useRef, onMounted } from "@odoo/owl";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { useService } from "@web/core/utils/hooks";
import { Navbar } from "@point_of_sale/app/components/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { Dialog } from "@web/core/dialog/dialog";

console.log("POS Discount Button - Loading...");

// =====================================================
// STORAGE HELPERS
// =====================================================
const STORAGE_KEY = "pos_discount_variants";

function getDiscountVariants() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return JSON.parse(stored);
    } catch (e) {}
    return [10, 20, 30, 40, 50];
}

function saveDiscountVariants(variants) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(variants));
    } catch (e) {}
}

// =====================================================
// HELPERS
// =====================================================
function findBtn(text) {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
        if (btn.textContent?.trim() === text) return btn;
    }
    return null;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// =====================================================
// POPUP COMPONENTS
// =====================================================
export class DiscountPopup extends Component {
    static template = "pos_boshar_discount.DiscountPopup";
    static components = { Dialog };
    static props = ["variants", "currentDiscount", "onSelect", "close"];

    onSelect(percent) {
        this.props.close();
        this.props.onSelect(percent);
    }
}

export class ManagePopup extends Component {
    static template = "pos_boshar_discount.ManagePopup";
    static components = { Dialog };
    static props = ["onAdd", "onEdit", "onDelete", "close"];

    onAction(action) {
        this.props.close();
        if (action === "add") this.props.onAdd();
        else if (action === "edit") this.props.onEdit();
        else if (action === "delete") this.props.onDelete();
    }
}

export class AddVariantPopup extends Component {
    static template = "pos_boshar_discount.AddVariantPopup";
    static components = { Dialog };
    static props = ["onConfirm", "close"];

    setup() {
        this.inputRef = useRef("addInput");
        onMounted(() => {
            setTimeout(() => {
                if (this.inputRef.el) {
                    this.inputRef.el.focus();
                }
            }, 100);
        });
    }

    onKeyup(ev) {
        if (ev.key === "Enter") this.onConfirm();
    }

    onConfirm() {
        const val = parseInt(this.inputRef.el?.value);
        this.props.close();
        this.props.onConfirm(val);
    }
}

export class EditVariantsPopup extends Component {
    static template = "pos_boshar_discount.EditVariantsPopup";
    static components = { Dialog };
    static props = ["variants", "onConfirm", "close"];

    onConfirm() {
        const inputs = document.querySelectorAll(".edit-variant-input");
        const newVars = [];
        inputs.forEach((inp) => {
            const val = parseInt(inp.value);
            if (!isNaN(val) && val >= 1 && val <= 100) newVars.push(val);
        });
        this.props.close();
        this.props.onConfirm([...new Set(newVars)].sort((a, b) => a - b));
    }
}

export class DeleteVariantPopup extends Component {
    static template = "pos_boshar_discount.DeleteVariantPopup";
    static components = { Dialog };
    static props = ["variants", "onDelete", "close"];

    onDelete(percent) {
        this.props.close();
        this.props.onDelete(percent);
    }
}

// =====================================================
// MAIN DISCOUNT BUTTON COMPONENT
// =====================================================
export class DiscountButton extends Component {
    static template = "pos_boshar_discount.DiscountButton";
    static props = {};

    setup() {
        this.pos = usePos();
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.state = useState({
            currentDiscount: 0,
        });
        this.isApplyingDiscount = false;
        this.discountVariants = getDiscountVariants();
    }

    onClickDiscount() {
        this.discountVariants = getDiscountVariants();
        this.dialog.add(DiscountPopup, {
            variants: [...this.discountVariants],
            currentDiscount: this.state.currentDiscount,
            onSelect: (percent) => {
                this.applyDiscountToAll(percent);
            },
        });
    }

    onClickManage() {
        this.dialog.add(ManagePopup, {
            onAdd: () => this._showAddPopup(),
            onEdit: () => this._showEditPopup(),
            onDelete: () => this._showDeletePopup(),
        });
    }

    _showAddPopup() {
        this.dialog.add(AddVariantPopup, {
            onConfirm: (val) => {
                if (!isNaN(val) && val >= 1 && val <= 100) {
                    if (!this.discountVariants.includes(val)) {
                        this.discountVariants.push(val);
                        this.discountVariants.sort((a, b) => a - b);
                        saveDiscountVariants(this.discountVariants);
                        this.notification.add(`${val}% added!`, { type: "success" });
                    } else {
                        this.notification.add(`${val}% already exists!`, { type: "warning" });
                    }
                } else {
                    this.notification.add("Enter value 1-100", { type: "danger" });
                }
            },
        });
    }

    _showEditPopup() {
        this.discountVariants = getDiscountVariants();
        this.dialog.add(EditVariantsPopup, {
            variants: [...this.discountVariants],
            onConfirm: (newVars) => {
                this.discountVariants = newVars;
                saveDiscountVariants(this.discountVariants);
                this.notification.add("Saved!", { type: "success" });
            },
        });
    }

    _showDeletePopup() {
        this.discountVariants = getDiscountVariants();
        this.dialog.add(DeleteVariantPopup, {
            variants: [...this.discountVariants],
            onDelete: (percent) => {
                this.discountVariants = this.discountVariants.filter((v) => v !== percent);
                saveDiscountVariants(this.discountVariants);
                this.notification.add(`${percent}% deleted!`, { type: "success" });
            },
        });
    }

    async onClickClear() {
        if (this.isApplyingDiscount) return;
        this.isApplyingDiscount = true;
        this.state.currentDiscount = 0;

        const orderlines = document.querySelectorAll(".orderline");
        if (orderlines.length === 0) {
            this.notification.add("No items", { type: "info" });
            this.isApplyingDiscount = false;
            return;
        }

        try {
            for (const line of orderlines) {
                line.click();
                await sleep(400);
                const percentBtn = document.querySelector(".numpad-discount") || findBtn("%");
                if (percentBtn) {
                    percentBtn.click();
                    await sleep(350);
                    const backspace = findBtn("\u232B");
                    if (backspace) {
                        for (let j = 0; j < 5; j++) { backspace.click(); await sleep(50); }
                    }
                    await sleep(200);
                    const zero = findBtn("0");
                    if (zero) { zero.click(); await sleep(120); }
                    await sleep(250);
                }
            }
            const qtyBtn = document.querySelector(".numpad-qty") || findBtn("Qty");
            if (qtyBtn) qtyBtn.click();
            this.notification.add("Discounts cleared!", { type: "info" });
        } catch (error) {
            console.error("Error clearing discounts:", error);
        } finally {
            this.isApplyingDiscount = false;
        }
    }

    async applyDiscountToAll(percent) {
        if (this.isApplyingDiscount) return;
        this.isApplyingDiscount = true;
        console.log(`Applying ${percent}% discount to ALL orderlines...`);
        this.state.currentDiscount = percent;

        const orderlines = document.querySelectorAll(".orderline");
        console.log(`Found ${orderlines.length} orderlines`);

        if (orderlines.length === 0) {
            this.notification.add("Add products first!", { type: "warning" });
            this.isApplyingDiscount = false;
            return;
        }

        try {
            for (let i = 0; i < orderlines.length; i++) {
                const line = orderlines[i];
                line.click();
                await sleep(400);
                const percentBtn = document.querySelector(".numpad-discount") || findBtn("%");
                if (percentBtn) {
                    percentBtn.click();
                    await sleep(350);
                    const backspace = findBtn("\u232B");
                    if (backspace) {
                        for (let j = 0; j < 5; j++) { backspace.click(); await sleep(50); }
                    }
                    await sleep(200);
                    const digits = percent.toString().split("");
                    for (const d of digits) {
                        const digitBtn = findBtn(d);
                        if (digitBtn) { digitBtn.click(); await sleep(120); }
                    }
                    await sleep(250);
                }
            }
            const qtyBtn = document.querySelector(".numpad-qty") || findBtn("Qty");
            if (qtyBtn) { qtyBtn.click(); await sleep(100); }
            this.notification.add(`${percent}% applied to all!`, { type: "success" });
            console.log("Done!");
        } catch (error) {
            console.error("Error:", error);
            this.notification.add("Error applying discount!", { type: "danger" });
        } finally {
            this.isApplyingDiscount = false;
        }
    }
}

// =====================================================
// PATCH NAVBAR
// =====================================================
patch(Navbar, {
    components: {
        ...Navbar.components,
        DiscountButton,
    },
});

console.log("POS Discount Button - Loaded successfully!");
