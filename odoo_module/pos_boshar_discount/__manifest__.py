{
    'name': 'POS Boshar Discount',
    'version': '19.0.1.0.0',
    'category': 'Point of Sale',
    'summary': 'Discount button in POS top bar with preset percentages',
    'description': """
        Discount button in POS top navigation bar.
        - Preset discount percentages (10%, 20%, 30%, 40%, 50%)
        - Apply discount to entire order
        - Manage discount variants (add/edit/delete)
    """,
    'author': 'Alphalize',
    'website': 'https://alphalize.com',
    'depends': ['point_of_sale'],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_boshar_discount/static/src/app/navbar/discount_button.js',
            'pos_boshar_discount/static/src/app/navbar/discount_button.xml',
            'pos_boshar_discount/static/src/app/navbar/discount_button.scss',
        ],
    },
    'installable': True,
    'application': False,
    'auto_install': False,
    'license': 'LGPL-3',
}
