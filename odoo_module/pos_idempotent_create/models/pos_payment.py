import logging
from odoo import api, fields, models

_logger = logging.getLogger(__name__)


class PosPayment(models.Model):
    _inherit = 'pos.payment'

    # Client-supplied idempotency key. If two creates arrive with the same
    # value, the second returns the existing record instead of duplicating.
    # Mirrors the pattern used on pos.order; see ./pos_order.py.
    client_uuid = fields.Char(
        string='Client UUID',
        index=True,
        copy=False,
        help='Client-generated UUID for idempotency. A retry / double-tap '
             'with the same value returns the first record.',
    )

    @api.model_create_multi
    def create(self, vals_list):
        remaining = []
        existing_records = self.browse()

        for vals in vals_list:
            uuid = vals.get('client_uuid')
            if uuid:
                existing = self.search(
                    [('client_uuid', '=', uuid)], limit=1
                )
                if existing:
                    _logger.info(
                        "pos_idempotent_create: duplicate create for "
                        "pos.payment client_uuid=%s -> returning existing "
                        "payment id=%s amount=%s",
                        uuid, existing.id, existing.amount,
                    )
                    existing_records |= existing
                    continue
            remaining.append(vals)

        created = super().create(remaining) if remaining else self.browse()
        return existing_records | created

    _sql_constraints = [
        (
            'client_uuid_uniq',
            'unique(client_uuid)',
            'A POS payment with this client_uuid already exists.',
        ),
    ]

    def init(self):
        self._cr.execute(
            """
            CREATE INDEX IF NOT EXISTS pos_payment_client_uuid_idx
            ON pos_payment (client_uuid)
            """
        )
