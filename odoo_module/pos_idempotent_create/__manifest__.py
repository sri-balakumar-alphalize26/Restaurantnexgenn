{
    'name': 'POS Idempotent Order Create',
    'version': '19.0.3.0.0',
    'category': 'Point of Sale',
    'summary': 'Dedupe pos.order create by client-supplied pos_reference (idempotency key)',
    'description': """
POS Idempotent Order Create
===========================
Overrides pos.order.create() so that a second create() with the same
pos_reference returns the existing record instead of creating a duplicate.

Prevents double orders when the APK/web POS retries a create request
after a network timeout that actually succeeded server-side.
    """,
    'depends': ['point_of_sale'],
    'data': [],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}
