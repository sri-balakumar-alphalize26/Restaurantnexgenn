# -*- coding: utf-8 -*-
from odoo import models, fields


class PosConfig(models.Model):
    _inherit = 'pos.config'

    kot_category_printer_ids = fields.One2many(
        'pos.kot.printer', 'config_id',
        string='KOT Printers',
    )
    kot_use_queue = fields.Boolean(
        string='Online Mode (Queue)',
        default=False,
        help='Enable when Odoo is hosted online/cloud and printers are on a local network. '
             'KOT jobs are queued and a local Print Agent picks them up.',
    )
