import logging
from odoo import api, fields, models

_logger = logging.getLogger(__name__)


class PosOrder(models.Model):
    _inherit = 'pos.order'

    # Client-supplied idempotency key. Unlike pos_reference (which Odoo
    # auto-generates as the Receipt Number), this field is owned by the
    # client and not touched by Odoo's POS pipeline, so it survives create()
    # and is reliable for dedup on retry.
    client_uuid = fields.Char(
        string='Client UUID',
        index=True,
        copy=False,
        help='Client-generated UUID. If two creates arrive with the same '
             'value, the second returns the first record instead of duplicating.',
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
                        "pos_idempotent_create: duplicate create for client_uuid=%s "
                        "-> returning existing order id=%s name=%s",
                        uuid, existing.id, existing.name,
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
            'A POS order with this client_uuid already exists.',
        ),
    ]

    def init(self):
        # Btree index for the dedup search; Odoo also creates one because
        # of index=True on the field, but this is idempotent.
        self._cr.execute(
            """
            CREATE INDEX IF NOT EXISTS pos_order_client_uuid_idx
            ON pos_order (client_uuid)
            """
        )
