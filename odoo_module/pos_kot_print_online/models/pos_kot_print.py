# -*- coding: utf-8 -*-
from odoo import models, api
from datetime import datetime
import pytz
import socket
import json
import logging
import os
import struct
import re
import base64

_logger = logging.getLogger(__name__)

# Module-level cache (Odoo recordsets disallow setting arbitrary instance attrs)
_RAQM_CACHE = {}


class PosKotPrint(models.Model):
    _name = 'pos.kot.print'
    _description = 'POS KOT Direct Print (image-based; works on any printer without Arabic codepage support)'

    # ─────────────────────────────────────────────────────────────────────────
    # Routing entry point
    # ─────────────────────────────────────────────────────────────────────────
    @api.model
    def print_kot(self, kot_data):
        try:
            _logger.info("=== KOT Print Request ===")
            items = kot_data.get('items', [])
            if not items:
                return {'success': True, 'message': 'No items'}

            config_id = kot_data.get('config_id', False)
            if not config_id:
                return {'success': False, 'message': 'No POS config ID in request'}

            config = self.env['pos.config'].browse(int(config_id))
            printers = config.kot_category_printer_ids
            if not printers:
                return {'success': False, 'message': 'No KOT printers configured.'}

            printer_groups = {}

            all_in_one = printers.filtered(lambda p: p.is_all_in_one)
            category_based = printers.filtered(lambda p: not p.is_all_in_one)

            for p in all_in_one:
                key = (p.printer_ip, int(p.printer_port))
                printer_groups[key] = list(items)

            if category_based:
                cat_map = {}
                for p in category_based:
                    for cat in p.category_ids:
                        if cat.id not in cat_map:
                            cat_map[cat.id] = (p.printer_ip, int(p.printer_port))

                for item in items:
                    cat_id = item.get('category_id')
                    key = cat_map.get(cat_id) if cat_id else None
                    if key:
                        printer_groups.setdefault(key, []).append(item)
                    else:
                        _logger.debug("Item '%s' (cat %s) has no matching category printer — skipped", item.get('name'), cat_id)

            if not printer_groups:
                return {'success': False, 'message': 'No items matched any configured printer'}

            # Route to queue or direct print
            if config.kot_use_queue:
                return self._queue_print(config, kot_data, printer_groups)
            else:
                return self._direct_print(kot_data, printer_groups)

        except Exception as e:
            _logger.exception("KOT error: %s", e)
            return {'success': False, 'message': str(e)}

    # -----------------------------------------------------------------------
    # Shared printer-grouping (used by print_kot and render_kot)
    # -----------------------------------------------------------------------
    def _build_printer_groups(self, printers, items):
        """Group order items by destination printer.

        - 'All in One' printers receive every item.
        - Category printers receive only items whose category_id matches.
        Mirrors the routing in print_kot so render_kot stays consistent.
        """
        printer_groups = {}
        all_in_one = printers.filtered(lambda p: p.is_all_in_one)
        category_based = printers.filtered(lambda p: not p.is_all_in_one)

        for p in all_in_one:
            key = (p.printer_ip, int(p.printer_port))
            printer_groups[key] = list(items)

        if category_based:
            cat_map = {}
            for p in category_based:
                for cat in p.category_ids:
                    if cat.id not in cat_map:
                        cat_map[cat.id] = (p.printer_ip, int(p.printer_port))
            for item in items:
                cat_id = item.get('category_id')
                key = cat_map.get(cat_id) if cat_id else None
                if key:
                    printer_groups.setdefault(key, []).append(item)
        return printer_groups

    # -----------------------------------------------------------------------
    # APK-agent mode: render bytes per printer and RETURN them (no socket/queue)
    # -----------------------------------------------------------------------
    @api.model
    def render_kot(self, kot_data):
        """Build the ESC/POS image receipt for each destination printer and
        return the raw bytes (base64) instead of printing or queuing.

        Used when the mobile app is the print agent: Odoo does the heavy
        rendering (categories + Arabic image), the app — which is on the same
        LAN as the printers — opens the TCP sockets and delivers the bytes.

        Returns:
            {'success': bool,
             'printers': [{'printer_ip', 'printer_port', 'data_b64', 'item_count'}],
             'message': str}
        """
        try:
            items = kot_data.get('items', [])
            if not items:
                return {'success': True, 'printers': [], 'message': 'No items'}

            config_id = kot_data.get('config_id', False)
            if not config_id:
                return {'success': False, 'message': 'No POS config ID in request'}

            config = self.env['pos.config'].browse(int(config_id))
            printers = config.kot_category_printer_ids
            if not printers:
                return {'success': False, 'message': 'No KOT printers configured.'}

            printer_groups = self._build_printer_groups(printers, items)
            if not printer_groups:
                return {'success': False, 'message': 'No items matched any configured printer'}

            out = []
            for (ip, port), group_items in printer_groups.items():
                built = self._build_receipt_image({**kot_data, 'items': group_items}, return_png=True)
                if not isinstance(built, tuple):
                    return {'success': False,
                            'message': 'Could not build receipt image (Pillow/font missing on server)'}
                escpos, png = built
                out.append({
                    'printer_ip': ip,
                    'printer_port': int(port),
                    'data_b64': base64.b64encode(escpos).decode('ascii'),
                    'png_b64': base64.b64encode(png).decode('ascii') if png else '',
                    'item_count': len(group_items),
                })
            _logger.info("render_kot: returned %d printer job(s) to mobile agent", len(out))
            return {'success': True, 'printers': out,
                    'message': 'Rendered %d printer job(s)' % len(out)}

        except Exception as e:
            _logger.exception("render_kot error: %s", e)
            return {'success': False, 'message': str(e)}

    # ─────────────────────────────────────────────────────────────────────────
    # Customer RECEIPT / INVOICE (reads the order from Odoo by order_id)
    # ─────────────────────────────────────────────────────────────────────────
    def _printers_for(self, config, doc_type):
        """Printers whose Type matches the document. 'counter' serves both."""
        roles = ('receipt', 'counter') if doc_type == 'receipt' else ('invoice', 'counter')
        return config.kot_category_printer_ids.filtered(lambda p: p.printer_type in roles)

    def _receipt_data_from_order(self, order_id):
        """Read a pos.order and return a flat dict for receipt/invoice rendering."""
        order = self.env['pos.order'].browse(int(order_id))
        if not order.exists():
            return None

        def _name(rec):
            try:
                return rec.name if rec else ''
            except Exception:
                return ''

        cashier = ''
        for f in ('employee_id', 'user_id'):
            try:
                rec = getattr(order, f, False)
                if rec:
                    cashier = rec.name
                    break
            except Exception:
                pass

        table_name = ''
        try:
            t = getattr(order, 'table_id', False)
            if t:
                table_name = t.name
        except Exception:
            pass

        lines = []
        for l in order.lines:
            try:
                nm = l.full_product_name or (l.product_id.display_name if l.product_id else 'Item')
            except Exception:
                nm = 'Item'
            note = ''
            for nf in ('customer_note', 'note'):
                try:
                    v = getattr(l, nf, '')
                    if v:
                        note = v
                        break
                except Exception:
                    pass
            lines.append({
                'name': nm,
                'qty': l.qty,
                'price': l.price_unit,
                'subtotal': getattr(l, 'price_subtotal_incl', l.price_subtotal),
                'note': note,
            })

        return {
            'order_name': order.pos_reference or order.name or '',
            'table_name': table_name,
            'cashier': cashier,
            'partner': _name(order.partner_id),
            'company': _name(order.company_id),
            'currency': (order.currency_id.symbol or '') if order.currency_id else '',
            'lines': lines,
            'amount_total': order.amount_total,
            'amount_tax': order.amount_tax,
            'amount_paid': getattr(order, 'amount_paid', 0.0),
            'config_id': order.config_id.id if order.config_id else False,
        }

    @api.model
    def render_receipt(self, order_id, config_id=None):
        """Online mode: return rendered bytes for the app to deliver."""
        return self._render_or_print_doc(order_id, config_id, 'receipt', do_print=False)

    @api.model
    def print_receipt(self, order_id, config_id=None):
        """Local mode: Odoo prints the receipt directly to the Receipt/Counter printer."""
        return self._render_or_print_doc(order_id, config_id, 'receipt', do_print=True)

    @api.model
    def render_invoice(self, order_id, config_id=None):
        return self._render_or_print_doc(order_id, config_id, 'invoice', do_print=False)

    @api.model
    def print_invoice(self, order_id, config_id=None):
        return self._render_or_print_doc(order_id, config_id, 'invoice', do_print=True)

    def _render_template_pdf(self, order):
        """Render the customer's dynamic_invoice_template POS receipt as PDF
        bytes (the SAME branded/bilingual receipt the browser shows).
        Returns None if that module/template isn't installed or isn't set to an
        engine/uploaded layout — caller then falls back to the simple layout."""
        try:
            cfg_model = self.env.get('invoice.template.config')
            if cfg_model is None:
                return None
            company = order.company_id or self.env.company
            cfg = cfg_model.sudo().get_config(company)
            if not cfg:
                return None
            valid = ('uploaded_pdf', 'engine_template')
            if cfg.template_theme != 'uploaded_pdf' and cfg.pos_receipt_layout not in valid:
                return None
            if cfg.pos_receipt_layout == 'engine_template':
                from odoo.addons.dynamic_invoice_template.models.uploaded_pdf_overlay import render_pos_engine_template
                pdf_bytes, _fn = render_pos_engine_template(self.env, cfg, order)
            else:
                if not (cfg.uploaded_pos_receipt_pdf or cfg.uploaded_invoice_pdf):
                    return None
                from odoo.addons.dynamic_invoice_template.models.uploaded_pdf_overlay import render_uploaded_pdf_overlay
                pdf_bytes, _fn = render_uploaded_pdf_overlay(self.env, cfg, order, 'pos_receipt')
            return pdf_bytes
        except Exception as e:
            _logger.warning("dynamic_invoice_template receipt not usable: %s", e)
            return None

    def _pdf_to_image(self, pdf_bytes, target_width=576):
        """Rasterize a PDF (thermal-width) to a single PIL image at target_width.
        Needs PyMuPDF (pip install pymupdf). Returns None if unavailable."""
        if not pdf_bytes:
            return None
        try:
            import fitz  # PyMuPDF
        except ImportError:
            _logger.warning("PyMuPDF not installed — cannot rasterize template PDF. "
                            "Run: \"<odoo>\\python\\python.exe\" -m pip install pymupdf")
            return None
        try:
            from PIL import Image
            doc = fitz.open(stream=pdf_bytes, filetype='pdf')
            imgs = []
            for page in doc:
                rect = page.rect
                zoom = (target_width / rect.width) if rect.width else 1.0
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom),
                                      colorspace=fitz.csGRAY, alpha=False)
                imgs.append(Image.frombytes('L', (pix.width, pix.height), pix.samples))
            doc.close()
            if not imgs:
                return None
            if len(imgs) == 1:
                return imgs[0]
            w = max(i.width for i in imgs)
            h = sum(i.height for i in imgs)
            canvas = Image.new('L', (w, h), 255)
            y = 0
            for i in imgs:
                canvas.paste(i, (0, y))
                y += i.height
            return canvas
        except Exception as e:
            _logger.warning("PDF->image failed: %s", e)
            return None

    def _render_or_print_doc(self, order_id, config_id, doc_type, do_print):
        try:
            order = self.env['pos.order'].browse(int(order_id))
            if not order.exists():
                return {'success': False, 'message': 'Order %s not found' % order_id}
            cfg_id = config_id or (order.config_id.id if order.config_id else False)
            if not cfg_id:
                return {'success': False, 'message': 'No POS config for order'}
            config = self.env['pos.config'].browse(int(cfg_id))
            printers = self._printers_for(config, doc_type)
            if not printers:
                return {'success': False,
                        'message': 'No %s printer configured. In KOT Setup set a printer Type to %s (or Counter).'
                                   % (doc_type, doc_type.title())}
            label = 'TAX INVOICE' if doc_type == 'invoice' else 'RECEIPT'

            # Prefer the customer's dynamic_invoice_template receipt (PDF -> image),
            # so app prints EXACTLY what the browser shows. Fall back to the simple
            # built-in layout if that module/PyMuPDF isn't available.
            img = self._pdf_to_image(self._render_template_pdf(order))
            if img is None:
                img = self._build_customer_receipt_image(
                    self._receipt_data_from_order(order_id), label)
            if img is None:
                return {'success': False,
                        'message': 'Could not render %s (Pillow/PyMuPDF/font missing on server)' % doc_type}

            escpos = (b'\x1b@' + b'\x1ba\x00' + self._image_to_escpos(img)
                      + b'\n' * 4 + b'\x1dV\x42\x00')

            if do_print:
                # Local print: save a copy on the server (rolling 20).
                self._save_receipt_archive(img, {'order_number': order.pos_reference or order.name or 'receipt'})
                errors = []
                for p in printers:
                    try:
                        self._socket_print(p.printer_ip, int(p.printer_port), escpos)
                        _logger.info("%s printed to %s:%s", doc_type, p.printer_ip, p.printer_port)
                    except Exception as e:
                        errors.append('%s:%s - %s' % (p.printer_ip, p.printer_port, e))
                if errors:
                    return {'success': False, 'message': 'Print errors: ' + '; '.join(errors)}
                return {'success': True, 'message': '%s sent to %d printer(s)' % (label, len(printers))}

            # Render-only (online): bytes + viewable PNG; NO server save.
            png = self._png_bytes(img)
            png_b64 = base64.b64encode(png).decode('ascii') if png else ''
            out = [{
                'printer_ip': p.printer_ip,
                'printer_port': int(p.printer_port),
                'data_b64': base64.b64encode(escpos).decode('ascii'),
                'png_b64': png_b64,
            } for p in printers]
            return {'success': True, 'printers': out, 'message': 'Rendered %s' % label}
        except Exception as e:
            _logger.exception("%s error: %s", doc_type, e)
            return {'success': False, 'message': str(e)}

    def _build_customer_receipt_image(self, data, label='RECEIPT'):
        """Fallback receipt/invoice renderer — returns a PIL image (used only
        when the dynamic_invoice_template module isn't configured).
        Supports prices, totals and bilingual (English / العربية) item names."""
        try:
            from PIL import Image, ImageDraw
        except ImportError:
            _logger.error("Pillow not installed on Odoo Python.")
            return None

        font_big, font_normal, font_small = self._find_fonts(40, 30, 24)
        if not font_normal:
            return None

        WIDTH = 576
        MARGIN = 12
        cur = data.get('currency', '') or ''

        def money(v):
            try:
                return ('%s %.3f' % (cur, float(v))).strip()
            except Exception:
                return str(v)

        rows = []
        def C(t, f, b=False): rows.append({'k': 'c', 't': str(t), 'f': f, 'b': b})
        def LFT(t, f, b=False): rows.append({'k': 'l', 't': str(t), 'f': f, 'b': b})
        def RGT(t, f, b=False): rows.append({'k': 'r', 't': str(t), 'f': f, 'b': b})
        def LR(l, r, f, b=False): rows.append({'k': 'lr', 'l': str(l), 'r': str(r), 'f': f, 'b': b})
        def SEP(): rows.append({'k': 'sep'})

        if data.get('company'):
            C(data['company'], font_big, True)
        C(label, font_normal, True)
        SEP()
        if data.get('order_name'):
            LFT('Order: ' + str(data['order_name']), font_small)
        if data.get('table_name'):
            LFT('Table: ' + str(data['table_name']), font_small)
        if data.get('cashier'):
            LFT('Cashier: ' + str(data['cashier']), font_small)
        if data.get('partner'):
            LFT('Customer: ' + str(data['partner']), font_small)
        SEP()

        for it in data.get('lines', []):
            qty = it.get('qty', 1)
            eng, ar = self._split_bilingual(str(it.get('name', 'Item')))
            LR('%g x %s' % (qty, eng), money(it.get('subtotal', 0)), font_normal, True)
            if ar:
                RGT(self._fix_arabic(ar), font_normal, True)
            if it.get('note'):
                eno, ano = self._split_bilingual(str(it['note']))
                if eno:
                    LFT('   ' + eno, font_small)
                if ano:
                    RGT(self._fix_arabic(ano), font_small)
        SEP()
        if data.get('amount_tax'):
            LR('Tax', money(data['amount_tax']), font_small)
        LR('TOTAL', money(data.get('amount_total', 0)), font_big, True)
        if data.get('amount_paid'):
            LR('Paid', money(data['amount_paid']), font_small)
        SEP()
        C('Thank you', font_small)

        def measure(f, t):
            try:
                bb = f.getbbox(t)
                return bb[2] - bb[0], bb[3] - bb[1]
            except Exception:
                return f.getsize(t)

        total_h = MARGIN * 2
        for r in rows:
            if r['k'] == 'sep':
                total_h += 16
                continue
            txt = r.get('t') or (r.get('l', '') + r.get('r', '')) or 'X'
            _, h = measure(r['f'], txt)
            total_h += h + 8
        total_h += 40

        img = Image.new('RGB', (WIDTH, total_h), 'white')
        draw = ImageDraw.Draw(img)
        y = MARGIN
        raqm = self._has_raqm()

        def dt(x, yy, t, f, b):
            kw = {'fill': 'black', 'font': f}
            if raqm:
                kw['direction'] = 'ltr'
            try:
                draw.text((x, yy), t, **kw)
                if b:
                    draw.text((x + 1, yy), t, **kw)
            except (TypeError, ValueError):
                draw.text((x, yy), t, fill='black', font=f)
                if b:
                    draw.text((x + 1, yy), t, fill='black', font=f)

        for r in rows:
            if r['k'] == 'sep':
                draw.line([(MARGIN, y + 6), (WIDTH - MARGIN, y + 6)], fill='black', width=2)
                y += 16
                continue
            f = r['f']
            b = r.get('b', False)
            if r['k'] == 'c':
                tw, th = measure(f, r['t'])
                dt(max(MARGIN, (WIDTH - tw) // 2), y, r['t'], f, b)
                y += th + 8
            elif r['k'] == 'r':
                tw, th = measure(f, r['t'])
                dt(max(MARGIN, WIDTH - MARGIN - tw), y, r['t'], f, b)
                y += th + 8
            elif r['k'] == 'l':
                _, th = measure(f, r['t'])
                dt(MARGIN, y, r['t'], f, b)
                y += th + 8
            else:  # lr
                lw, lh = measure(f, r['l'])
                rw, rh = measure(f, r['r'])
                dt(MARGIN, y, r['l'], f, b)
                dt(max(MARGIN + lw + 10, WIDTH - MARGIN - rw), y, r['r'], f, b)
                y += max(lh, rh) + 8

        return img

    # ─────────────────────────────────────────────────────────────────────────
    # TCP socket
    # ─────────────────────────────────────────────────────────────────────────

    # -----------------------------------------------------------------------
    # Direct print (local mode)
    # -----------------------------------------------------------------------
    def _direct_print(self, kot_data, printer_groups):
        errors = []
        for (ip, port), group_items in printer_groups.items():
            try:
                receipt = self._build_receipt_image({**kot_data, 'items': group_items}, save_archive=True)
                if receipt is None:
                    errors.append("%s:%s - could not build receipt image" % (ip, port))
                    continue
                self._socket_print(ip, port, receipt)
                _logger.info("KOT printed to %s:%s (%d items)", ip, port, len(group_items))
            except Exception as e:
                _logger.error("Print error to %s:%s - %s", ip, port, e)
                errors.append("%s:%s - %s" % (ip, port, e))
        if errors:
            return {'success': False, 'message': 'Print errors: ' + '; '.join(errors)}
        return {'success': True, 'message': 'KOT sent to %d printer(s)' % len(printer_groups)}

    # -----------------------------------------------------------------------
    # Queue print (online/cloud mode)
    # -----------------------------------------------------------------------
    def _queue_print(self, config, kot_data, printer_groups):
        queue_model = self.env['pos.kot.queue'].sudo()
        queued = 0
        for (ip, port), group_items in printer_groups.items():
            queue_data = dict(kot_data)
            queue_data['items'] = group_items
            queue_model.create({
                'config_id': config.id,
                'printer_ip': ip,
                'printer_port': port,
                'data': json.dumps(queue_data, default=str),
                'state': 'pending',
            })
            queued += 1
            _logger.info("KOT queued for %s:%s (%d items)", ip, port, len(group_items))
        return {'success': True, 'message': 'KOT queued for %d printer(s). Print Agent will pick up.' % queued}

    def _socket_print(self, ip, port, data):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(10)
        try:
            s.connect((str(ip), int(port)))
            s.sendall(data)
            try:
                s.shutdown(socket.SHUT_WR)
            except Exception:
                pass
        finally:
            try:
                s.close()
            except Exception:
                pass

    # ─────────────────────────────────────────────────────────────────────────
    # Bilingual + Arabic helpers
    # ─────────────────────────────────────────────────────────────────────────
    def _split_bilingual(self, text):
        """Split 'English / Arabic' into (eng, ar). Returns (text, None) if no Arabic part after the slash."""
        if not text:
            return '', None
        s = str(text)
        m = re.match(r'^(.*?)\s*/\s*(.+)$', s)
        if m:
            eng = m.group(1).strip()
            ar = m.group(2).strip()
            if any('؀' <= c <= 'ۿ' for c in ar):
                return eng, ar
        return s.strip(), None

    def _has_raqm(self):
        """Whether Pillow was built with libraqm (handles Arabic shaping + bidi natively).
        Cached on the module-level dict, since Odoo recordsets disallow arbitrary attrs."""
        cached = _RAQM_CACHE.get('available')
        if cached is None:
            try:
                from PIL import features
                cached = bool(features.check('raqm'))
            except Exception:
                cached = False
            _RAQM_CACHE['available'] = cached
        return cached

    def _fix_arabic(self, text):
        """Prepare Arabic text for PIL drawing.
        - If libraqm is available, return text untouched — libraqm handles
          contextual shaping + bidi internally during draw.text().
        - Without libraqm, pre-shape with arabic_reshaper + bidi.get_display so
          each glyph is in its visual position when PIL draws LTR."""
        if not text:
            return ''
        s = str(text)
        if not any('؀' <= c <= 'ۿ' for c in s):
            return s
        if self._has_raqm():
            return s
        try:
            import arabic_reshaper
            from bidi.algorithm import get_display
            return get_display(arabic_reshaper.reshape(s))
        except ImportError:
            return s
        except Exception:
            return s

    # ─────────────────────────────────────────────────────────────────────────
    # Image rendering → ESC/POS raster (GS v 0)
    # ─────────────────────────────────────────────────────────────────────────
    def _image_to_escpos(self, img):
        img = img.convert('1')
        width, height = img.size

        pad_width = ((width + 7) // 8) * 8
        if pad_width != width:
            from PIL import Image
            padded = Image.new('1', (pad_width, height), 1)
            padded.paste(img, (0, 0))
            img = padded
            width = pad_width

        byte_width = width // 8
        out = bytearray()
        out += b'\x1d\x76\x30\x00'
        out += struct.pack('<H', byte_width)
        out += struct.pack('<H', height)

        pixels = list(img.getdata())
        for y in range(height):
            for xb in range(byte_width):
                byte = 0
                for bit in range(8):
                    x = xb * 8 + bit
                    if pixels[y * width + x] == 0:
                        byte |= (0x80 >> bit)
                out.append(byte)
        return bytes(out)

    def _find_fonts(self, big_size, normal_size, small_size):
        try:
            from PIL import ImageFont
        except ImportError:
            return None, None, None

        # Font priority: try Arabic-rich fonts first so glyph shapes match the
        # browser's rendering as closely as possible. Order matters — first match wins.
        win_fonts = os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts')
        candidates = [
            os.path.join(win_fonts, 'arial.ttf'),       # most browsers fall back to Arial for Arabic
            os.path.join(win_fonts, 'arialuni.ttf'),    # Arial Unicode MS — broad Arabic glyph set
            os.path.join(win_fonts, 'tahoma.ttf'),      # solid Arabic shapes, slightly compressed
            os.path.join(win_fonts, 'calibri.ttf'),
            os.path.join(win_fonts, 'segoeui.ttf'),
            os.path.join(win_fonts, 'times.ttf'),
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
        ]
        for fp in candidates:
            if os.path.exists(fp):
                try:
                    return (
                        ImageFont.truetype(fp, big_size),
                        ImageFont.truetype(fp, normal_size),
                        ImageFont.truetype(fp, small_size),
                    )
                except Exception:
                    pass
        return None, None, None

    def _save_receipt_archive(self, img, kot_data):
        """Save the rendered receipt PNG inside <module>/kotprintimage/<db_name>/.
        Auto-cleanup: deletes PNGs older than 7 days."""
        try:
            import time as _time
            module_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            db_name = self.env.cr.dbname or 'default'
            safe_db = re.sub(r'[^A-Za-z0-9_-]', '_', db_name)
            save_dir = os.path.join(module_dir, 'kotprintimage', safe_db)
            os.makedirs(save_dir, exist_ok=True)

            ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
            order_no = str(kot_data.get('order_number') or kot_data.get('order_name') or 'kot')
            order_no = re.sub(r'[^A-Za-z0-9_-]', '', order_no)[:20] or 'kot'
            png_path = os.path.join(save_dir, 'kot_%s_%s.png' % (ts, order_no))
            img.save(png_path)

            # Rolling buffer: keep only the newest MAX_KEEP images. When a new
            # one is saved, the oldest (by time, ascending) are removed — so KOT
            # and counter/bill prints never grow beyond MAX_KEEP files.
            MAX_KEEP = 20
            pngs = [os.path.join(save_dir, fn) for fn in os.listdir(save_dir)
                    if fn.lower().endswith('.png')]
            pngs.sort(key=lambda p: os.path.getmtime(p))  # oldest first
            for old in (pngs[:-MAX_KEEP] if len(pngs) > MAX_KEEP else []):
                try:
                    os.remove(old)
                except OSError:
                    pass
        except Exception as e:
            _logger.warning("KOT image archive save skipped: %s", e)

    def _measure_text(self, font, text):
        try:
            bbox = font.getbbox(text)
            return bbox[2] - bbox[0], bbox[3] - bbox[1]
        except AttributeError:
            return font.getsize(text)

    def _wrap_to_width(self, text, font, max_width):
        """Greedy word-wrap so a long Arabic/English line doesn't overflow the receipt width.
        Splits on whitespace; never breaks inside a word (Arabic joining stays intact)."""
        if not text:
            return []
        words = str(text).split(' ')
        lines, cur = [], ''
        for w in words:
            cand = (cur + ' ' + w).strip() if cur else w
            tw, _ = self._measure_text(font, cand)
            if tw <= max_width or not cur:
                cur = cand
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        return lines

    def _png_bytes(self, img):
        """PNG bytes of a PIL image (for a viewable copy on the printing device)."""
        try:
            import io
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            return buf.getvalue()
        except Exception:
            return None

    def _build_receipt_image(self, kot_data, save_archive=False, return_png=False):
        try:
            from PIL import Image, ImageDraw
        except ImportError:
            _logger.error("Pillow not installed on Odoo Python. Run: pip install Pillow")
            return None

        font_big, font_normal, font_small = self._find_fonts(48, 36, 28)
        if not font_normal:
            _logger.error("No TTF font available for image-based KOT rendering")
            return None

        WIDTH = 576
        MARGIN = 12
        TEXT_W = WIDTH - 2 * MARGIN  # usable text width

        try:
            local_tz = pytz.timezone('Asia/Muscat')
            local_time = datetime.now(pytz.UTC).astimezone(local_tz)
        except Exception:
            local_time = datetime.now()

        order_type = str(kot_data.get('order_type', '') or 'Dine In')
        now_time = local_time.strftime('%I:%M:%S %p')
        if order_type.lower() in ('takeout', 'delivery', 'takeaway'):
            order_type_display = '%s (%s)' % (order_type, now_time)
        else:
            order_type_display = order_type

        lines = []

        def L(text, font, align='center', bold=False):
            if text is None:
                return
            t = str(text)
            if not t:
                return
            lines.append({'text': t, 'font': font, 'align': align, 'bold': bold})

        def SEP():
            lines.append({'sep': True})

        # Header
        eng_ot, ar_ot = self._split_bilingual(order_type_display)
        L(eng_ot, font_big, 'center', True)
        if ar_ot:
            L(self._fix_arabic(ar_ot), font_big, 'center', True)

        # For Dine In, show the table number prominently in the header
        table_name = str(kot_data.get('table_name', '') or '')
        is_dinein = order_type.strip().lower() in ('dine in', 'dinein', 'dine-in')
        if is_dinein and table_name:
            L('Table: ' + table_name, font_big, 'center', True)

        L('Time: ' + local_time.strftime('%H:%M'), font_small, 'center')

        slot_time = str(kot_data.get('slot_time', '') or '')
        if slot_time:
            L('Slot: ' + slot_time, font_small, 'center', True)

        waiter = str(kot_data.get('waiter', '') or kot_data.get('cashier', '') or '')
        if waiter:
            L('Waiter: ' + waiter, font_small, 'center')

        order_name = str(kot_data.get('order_name', '') or '')
        if order_name:
            eng_on, ar_on = self._split_bilingual(order_name)
            if eng_on:
                L('Order: ' + eng_on, font_small, 'center')
            if ar_on:
                L(self._fix_arabic(ar_on), font_small, 'center')

        # Combined order line. For Dine In we already showed the table above,
        # so omit it here to avoid duplication. For takeout/delivery, include it if present.
        order_number = str(kot_data.get('order_number', '') or order_name or '')
        order_line = 'Order'
        if not is_dinein and table_name:
            order_line += ' ' + table_name
        if order_number:
            order_line += ' # ' + order_number
        L(order_line, font_big, 'center', True)

        guest_count = kot_data.get('guest_count', 0)
        if guest_count:
            L('Guests: ' + str(guest_count), font_small, 'center')

        SEP()

        print_type = str(kot_data.get('print_type', 'NEW'))
        L(print_type, font_big, 'center', True)
        SEP()

        # Items — long lines auto-wrap so Arabic + numbers don't get clipped
        for item in kot_data.get('items', []):
            name = str(item.get('name', 'Item'))
            qty = int(item.get('qty', 1))
            note = str(item.get('note', '') or '')

            eng_n, ar_n = self._split_bilingual(name)

            eng_first = '{}  {}'.format(qty, eng_n) if eng_n else str(qty)
            for w in (self._wrap_to_width(eng_first, font_normal, TEXT_W) or [eng_first]):
                L(w, font_normal, 'left', True)

            if ar_n:
                ar_fixed = self._fix_arabic(ar_n)
                for w in (self._wrap_to_width(ar_fixed, font_normal, TEXT_W) or [ar_fixed]):
                    L(w, font_normal, 'right', True)

            if note:
                eng_no, ar_no = self._split_bilingual(note)
                if eng_no:
                    for w in (self._wrap_to_width('  >> ' + eng_no, font_small, TEXT_W) or [eng_no]):
                        L(w, font_small, 'left')
                if ar_no:
                    ar_note_fixed = self._fix_arabic(ar_no)
                    for w in (self._wrap_to_width(ar_note_fixed, font_small, TEXT_W) or [ar_note_fixed]):
                        L(w, font_small, 'right')

        SEP()

        # Measure
        tmp = Image.new('RGB', (WIDTH, 10), 'white')
        td = ImageDraw.Draw(tmp)
        total_h = MARGIN * 2
        for ln in lines:
            if ln.get('sep'):
                total_h += 18
                continue
            try:
                bbox = ln['font'].getbbox(ln['text'])
                total_h += (bbox[3] - bbox[1]) + 10
            except AttributeError:
                _, h = ln['font'].getsize(ln['text'])
                total_h += h + 10
        total_h += 60

        # Draw
        img = Image.new('RGB', (WIDTH, total_h), 'white')
        draw = ImageDraw.Draw(img)
        y = MARGIN

        for ln in lines:
            if ln.get('sep'):
                draw.line([(MARGIN, y + 8), (WIDTH - MARGIN, y + 8)], fill='black', width=2)
                y += 18
                continue

            text = ln['text']
            font = ln['font']
            try:
                bbox = font.getbbox(text)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
            except AttributeError:
                tw, th = font.getsize(text)

            if ln['align'] == 'center':
                x = max(MARGIN, (WIDTH - tw) // 2)
            elif ln['align'] == 'right':
                x = max(MARGIN, WIDTH - MARGIN - tw)
            else:
                x = MARGIN

            # Force LTR direction so Arabic prints in the same logical order
            # the user typed (matches what the POS UI shows). With libraqm,
            # default direction is 'ltr', but we pass it explicitly to override
            # any auto-detection of RTL for Arabic-heavy lines.
            draw_kwargs = {'fill': 'black', 'font': font}
            if self._has_raqm():
                draw_kwargs['direction'] = 'ltr'

            try:
                draw.text((x, y), text, **draw_kwargs)
                if ln.get('bold'):
                    draw.text((x + 1, y), text, **draw_kwargs)
            except (TypeError, ValueError):
                # Fallback: very old Pillow / no direction support
                draw.text((x, y), text, fill='black', font=font)
                if ln.get('bold'):
                    draw.text((x + 1, y), text, fill='black', font=font)

            y += th + 10

        # Archive on the SERVER only when the server itself prints (local mode).
        # For the APK path (render only), we return bytes and do NOT store on
        # the server — the device that prints owns the copy.
        if save_archive:
            self._save_receipt_archive(img, kot_data)

        data = b'\x1b@'
        data += b'\x1ba\x00'
        data += self._image_to_escpos(img)
        data += b'\n' * 4
        data += b'\x1dV\x42\x00'

        return (data, self._png_bytes(img)) if return_png else data
