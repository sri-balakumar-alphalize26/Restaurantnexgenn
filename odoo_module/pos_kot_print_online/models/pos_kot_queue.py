# -*- coding: utf-8 -*-
from odoo import models, fields, api
import json
import logging

_logger = logging.getLogger(__name__)


class PosKotQueue(models.Model):
    _name = 'pos.kot.queue'
    _description = 'KOT Print Queue'
    _order = 'create_date asc'

    config_id = fields.Many2one('pos.config', string='POS Config')
    printer_ip = fields.Char(string='Printer IP')
    printer_port = fields.Integer(string='Printer Port', default=9100)
    data = fields.Text(string='KOT Data (JSON)')
    state = fields.Selection([
        ('pending', 'Pending'),
        ('done', 'Done'),
        ('failed', 'Failed'),
    ], string='State', default='pending', index=True)
    error_message = fields.Text(string='Error')

    @api.model
    def get_pending(self, printer_ip=None):
        domain = [('state', '=', 'pending')]
        if printer_ip:
            domain.append(('printer_ip', '=', printer_ip))
        records = self.sudo().search(domain, limit=50)
        result = []
        for r in records:
            try:
                kot_data = json.loads(r.data) if r.data else {}
            except Exception:
                kot_data = {}
            result.append({
                'id': r.id,
                'printer_ip': r.printer_ip,
                'printer_port': r.printer_port,
                'data': kot_data,
            })
        return result

    @api.model
    def get_pending_all(self):
        return self.get_pending(printer_ip=None)

    @api.model
    def mark_done(self, ids):
        records = self.sudo().browse(ids)
        records.write({'state': 'done'})
        return True

    @api.model
    def mark_failed(self, ids, error=''):
        records = self.sudo().browse(ids)
        records.write({'state': 'failed', 'error_message': error})
        return True

    @api.autovacuum
    def _gc_old_records(self):
        from datetime import timedelta
        limit = fields.Datetime.now() - timedelta(days=7)
        old = self.sudo().search([
            ('state', 'in', ['done', 'failed']),
            ('create_date', '<', limit),
        ])
        old.unlink()
