{
    'name': 'KOT Printer Online',
    'version': '19.0.7.0.0',
    'category': 'Point of Sale',
    'summary': 'KOT Printer - Local & Online mode with queue, connection status, image-based Arabic support',
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'views/pos_config_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_kot_print_online/static/src/js/kot_button.js',
            'pos_kot_print_online/static/src/xml/kot_button.xml',
            'pos_kot_print_online/static/src/css/kot_button.css',
        ],
    },
    'installable': True,
    'license': 'LGPL-3',
    'post_init_hook': '_post_init_hook',
}
