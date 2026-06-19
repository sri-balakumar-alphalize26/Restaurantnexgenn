# -*- coding: utf-8 -*-
from odoo import models, fields
import socket
import logging

_logger = logging.getLogger(__name__)


class PosKotPrinter(models.Model):
    _name = 'pos.kot.printer'
    _description = 'KOT Printer Configuration'
    _order = 'sequence, id'

    sequence = fields.Integer(default=10)
    name = fields.Char(string='Printer Name', required=True)
    printer_ip = fields.Char(string='KOT IP', required=True)
    printer_port = fields.Integer(string='Port', default=9100)
    printer_type = fields.Selection([
        ('kot', 'Kitchen (KOT)'),
        ('receipt', 'Receipt'),
        ('invoice', 'Invoice'),
        ('counter', 'Counter (Receipt + Invoice)'),
    ], string='Type', default='kot', required=True,
        help='What this printer prints:\n'
             '- Kitchen (KOT): kitchen order tickets (routed by category).\n'
             '- Receipt: customer counter receipt.\n'
             '- Invoice: tax invoice.\n'
             '- Counter: both receipt and invoice.')
    is_all_in_one = fields.Boolean(
        string='All in One KOT',
        default=False,
        help='If enabled, ALL order items are sent to this printer regardless of category.'
    )
    category_ids = fields.Many2many(
        'pos.category',
        'pos_kot_printer_category_rel',
        'printer_id', 'category_id',
        string='Categories',
        help='Items from these categories will print to this printer. '
             'Ignored when "All in One KOT" is enabled.'
    )
    config_id = fields.Many2one('pos.config', string='POS Config', ondelete='cascade', required=True)
    connection_status = fields.Selection([
        ('unknown', 'Unknown'),
        ('online', 'Online'),
        ('offline', 'Offline'),
        ('agent', 'Via Agent'),
    ], string='Status', default='unknown', store=True, readonly=True)

    def action_test_connection(self):
        """Test printer connection.
        Local mode: TCP socket test to printer IP:port.
        Queue mode: check if Print Agent has recent activity.
        """
        for printer in self:
            use_queue = printer.config_id.kot_use_queue if printer.config_id else False

            if use_queue:
                recent = self.env['pos.kot.queue'].sudo().search_count([
                    ('printer_ip', '=', printer.printer_ip),
                    ('state', '=', 'done'),
                    ('create_date', '>=', fields.Datetime.subtract(fields.Datetime.now(), days=1)),
                ])
                if recent > 0:
                    printer.connection_status = 'agent'
                else:
                    self.env['pos.kot.queue'].sudo().create({
                        'config_id': printer.config_id.id,
                        'printer_ip': printer.printer_ip,
                        'printer_port': printer.printer_port,
                        'data': '{"test": true, "items": []}',
                        'state': 'pending',
                    })
                    printer.connection_status = 'agent'
            else:
                try:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.settimeout(3)
                    s.connect((str(printer.printer_ip), int(printer.printer_port)))
                    s.close()
                    printer.connection_status = 'online'
                    _logger.info("Printer %s (%s:%s) is ONLINE", printer.name, printer.printer_ip, printer.printer_port)
                except Exception as e:
                    printer.connection_status = 'offline'
                    _logger.warning("Printer %s (%s:%s) is OFFLINE: %s", printer.name, printer.printer_ip, printer.printer_port, e)

        status_map = {'online': 'Connected', 'offline': 'Not Reachable', 'agent': 'Via Print Agent', 'unknown': 'Unknown'}
        messages = []
        for p in self:
            messages.append('%s: %s' % (p.name, status_map.get(p.connection_status, 'Unknown')))

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': 'Connection Test',
                'message': '\n'.join(messages),
                'type': 'info' if all(p.connection_status in ('online', 'agent') for p in self) else 'warning',
                'sticky': False,
            }
        }
