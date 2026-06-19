/**
 * KOT Service for React Native APK + Odoo
 *
 * Uses session-based auth via /web/dataset/call_kw (same as rest of the app).
 * Reads server URL, session ID, and DB from AsyncStorage.
 *
 * ARCHITECTURE:
 *   APK (React Native)  ──session auth──>  Odoo Server  ──TCP/ESC-POS──>  KOT Printer
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { isLocalServerUrl } from '@utils/network/serverMode';
import { deliverRenderedJobs } from '@utils/printing/lanPrinter';

// ── Read connection info from AsyncStorage ───────────────────

async function getConnectionInfo() {
  const pairs = await AsyncStorage.multiGet([
    'device_server_url',
    'odoo_session_id',
    'userData',
    'device_db_name',
    'odoo_db',
  ]);

  const serverUrl = pairs[0][1];
  let session = pairs[1][1];
  const userData = pairs[2][1] ? JSON.parse(pairs[2][1]) : null;
  const dbName = pairs[3][1] || pairs[4][1];

  // Fallback: session might be inside userData
  if (!session && userData?.session_id) {
    session = userData.session_id;
  }

  if (!serverUrl) {
    throw new Error('No server URL configured. Please login again.');
  }
  if (!session) {
    throw new Error('No session found. Please login again.');
  }

  const base = serverUrl.replace(/\/+$/, '');

  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `session_id=${session}`,
    'X-Openerp-Session-Id': session,
  };
  if (dbName) headers['X-Odoo-Database'] = dbName;

  return { base, headers, session, dbName, uid: userData?.uid };
}

// ── Odoo RPC call via session ────────────────────────────────

export async function callKw(model, method, args = [[]], kwargs = {}) {
  const { base, headers } = await getConnectionInfo();

  const url = `${base}/web/dataset/call_kw`;
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      model,
      method,
      args,
      kwargs: { ...kwargs, context: kwargs.context || {} },
    },
  };

  console.log(`[KOT] POST ${url}`);
  console.log('[KOT] model:', model, 'method:', method);
  console.log('[KOT] payload:', JSON.stringify(payload, null, 2));

  const response = await axios.post(url, payload, {
    headers,
    timeout: 15000,
    // Caller (printKot, loadPosConfig, etc.) handles its own errors and
    // shows the right user-facing message. Skip the global popup so a KOT
    // print failure doesn't blanket-mask the actual error context.
    __skipNetworkErrorPopup: true,
  });

  console.log('[KOT] response status:', response.status);

  if (response.data?.error) {
    const msg =
      response.data.error.data?.message ||
      response.data.error.message ||
      'Odoo RPC Error';
    console.error('[KOT] Odoo error:', msg);
    throw new Error(msg);
  }

  return response.data?.result;
}

// ── Fetch POS Config (printer settings from Odoo) ───────────
// Loaded once at login via loadPosConfig() and cached for the session.
// Cleared on logout via clearPosConfigCache().

let _posConfigCache = null;

async function _fetchPosConfig(configId) {
  try {
    const configs = await callKw(
      'pos.config',
      'search_read',
      [configId ? [['id', '=', configId]] : []],
      {
        fields: ['id', 'kot_printer_ip', 'kot_printer_port', 'kot_use_print_agent', 'kot_agent_url', 'payment_pin'],
        limit: 1,
      },
    );
    if (configs && configs.length) {
      console.log('[KOT] POS config loaded:', JSON.stringify(configs[0]));
      return configs[0];
    }
  } catch (error) {
    console.warn('[KOT] Failed to load POS config:', error.message);
  }
  return null;
}

async function getPosConfig(configId) {
  if (_posConfigCache) return _posConfigCache;
  _posConfigCache = await _fetchPosConfig(configId);
  return _posConfigCache;
}

export async function loadPosConfig(configId) {
  _posConfigCache = await _fetchPosConfig(configId);
  return _posConfigCache;
}

export function clearPosConfigCache() {
  _posConfigCache = null;
}

// ── Print KOT ────────────────────────────────────────────────

/**
 * Send KOT to Odoo for printing. Odoo handles the printer.
 *
 * @param {object}  kotData
 * @param {string}  kotData.table_name    - "T 3"
 * @param {string}  kotData.order_name    - "Order 00012"
 * @param {number}  [kotData.order_id]    - Odoo pos.order ID
 * @param {string}  kotData.cashier       - Waiter / server name
 * @param {string}  [kotData.order_type]  - "Dine In" | "Takeout" | "Delivery"
 * @param {number}  [kotData.guest_count] - Number of guests
 * @param {string}  [kotData.print_type]  - "NEW" | "ADDON" | "FULL"
 * @param {number}  [kotData.config_id]   - POS config ID
 * @param {Array<{name:string, qty:number, note?:string}>} kotData.items
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function printKot(kotData) {
  try {
    const configId = kotData.config_id || null;
    const posConfig = await getPosConfig(configId);

    const printerIp = posConfig?.kot_printer_ip || '192.168.0.100';
    const printerPort = posConfig?.kot_printer_port || 9100;

    // Backstop fallbacks — guarantee order_name and slot_time are never empty/"/"
    const _now = new Date();
    const _pad = (n) => String(n).padStart(2, '0');
    const _nowDate = `${_pad(_now.getMonth() + 1)}/${_pad(_now.getDate())}/${_now.getFullYear()}`;
    const _nowTime = `${_pad(_now.getHours())}:${_pad(_now.getMinutes())}`;

    const _rawName = String(kotData.order_name || '').trim();
    const _rawTable = String(kotData.table_name || '').trim();
    const _nameOut =
      _rawName && _rawName !== '/' ? _rawName :
      _rawTable ? _rawTable :
      (kotData.order_id ? `Order ${kotData.order_id}` : 'Order');

    const _rawSlot = String(kotData.slot_time || '').trim();
    const _slotOut = _rawSlot || `${_nowDate} ${_nowTime}`;

    // A POS config id is required for category→printer routing on the server.
    let resolvedConfigId = posConfig?.id || configId || null;
    if (!resolvedConfigId) {
      try {
        const cfgs = await callKw('pos.config', 'search_read', [[]], { fields: ['id'], limit: 1 });
        resolvedConfigId = (cfgs && cfgs[0] && cfgs[0].id) || false;
      } catch (_) {}
    }

    const data = {
      table_name: kotData.table_name || '',
      order_name: _nameOut,
      order_number: _nameOut,
      cashier: kotData.cashier || '',
      waiter: kotData.cashier || '',
      order_type: kotData.order_type || 'Dine In',
      guest_count: kotData.guest_count || 0,
      print_type: kotData.print_type || 'NEW',
      slot_time: _slotOut,
      config_id: resolvedConfigId || false,
      printer_ip: printerIp,
      printer_port: printerPort,
      items: (kotData.items || []).map((it) => ({
        name: it.name || 'Item',
        qty: Number(it.qty || 1),
        note: it.note || '',
        // category_id drives multi-printer routing (e.g. Food→pizza, Drinks→juice)
        category_id: it.category_id != null ? it.category_id : null,
      })),
    };

    console.log('[KOT] printKot data:', JSON.stringify(data, null, 2));

    // Local server → Odoo reaches the printers and prints directly.
    // Online server → this app is the print agent: Odoo renders the bytes,
    // we deliver them to the printers over the LAN.
    const serverUrl = (await AsyncStorage.getItem('device_server_url')) || '';
    if (isLocalServerUrl(serverUrl)) {
      const result = await callKw('pos.kot.print', 'print_kot', [data]);
      console.log('[KOT] printKot (local) result:', JSON.stringify(result));
      return result || { success: true };
    }

    console.log('[KOT] online mode — render on server, print from app over LAN');
    const rendered = await callKw('pos.kot.print', 'render_kot', [data]);
    if (!rendered || rendered.success === false) {
      return { success: false, error: rendered?.message || 'Server could not render KOT' };
    }
    const jobs = rendered.printers || [];
    if (!jobs.length) {
      return { success: false, error: 'No printer matched these items. Check KOT Setup categories.' };
    }
    const delivered = await deliverRenderedJobs(jobs, 'kot');
    console.log('[KOT] online delivery result:', JSON.stringify(delivered));
    return delivered;
  } catch (error) {
    console.error('[KOT] printKot error:', error.message);
    return { success: false, error: error.message };
  }
}

// ── Customer receipt / invoice ───────────────────────────────
// Best-effort: Odoo reads the order by id, renders the document, and prints
// to the Receipt/Counter printer (local) or returns bytes for the app to
// deliver (online). Never throws — returns {success:false} so callers can
// fire-and-forget without breaking the payment flow.

async function _printDocument(docType, orderId, configId) {
  try {
    if (!orderId) return { success: false, error: 'No order id' };
    const serverUrl = (await AsyncStorage.getItem('device_server_url')) || '';
    const local = isLocalServerUrl(serverUrl);
    const method = local ? `print_${docType}` : `render_${docType}`;
    const result = await callKw('pos.kot.print', method, [orderId, configId || false]);

    if (local) {
      return result || { success: true };
    }
    if (!result || result.success === false) {
      return { success: false, error: result?.message || `Server could not render ${docType}` };
    }
    const jobs = result.printers || [];
    if (!jobs.length) return { success: false, error: `No ${docType} printer configured` };
    return await deliverRenderedJobs(jobs, docType);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function printReceipt(orderId, configId = null) {
  return _printDocument('receipt', orderId, configId);
}

export async function printInvoice(orderId, configId = null) {
  return _printDocument('invoice', orderId, configId);
}

// ── Fetch Data from Odoo ─────────────────────────────────────

export async function getTables() {
  try {
    const tables = await callKw(
      'restaurant.table',
      'search_read',
      [[]],
      { fields: ['id', 'name', 'seats', 'floor_id', 'active'] },
    );
    return { success: true, tables: tables || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function getProducts(limit = 200) {
  try {
    const products = await callKw(
      'product.product',
      'search_read',
      [[['available_in_pos', '=', true]]],
      {
        fields: ['id', 'name', 'display_name', 'list_price', 'categ_id', 'pos_categ_ids'],
        limit,
      },
    );
    return { success: true, products: products || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function fetchOrder(orderId) {
  try {
    const orders = await callKw(
      'pos.order',
      'read',
      [[orderId]],
      {
        fields: [
          'id', 'name', 'lines', 'state', 'table_id',
          'partner_id', 'amount_total',
        ],
      },
    );
    const order = Array.isArray(orders) && orders.length ? orders[0] : null;
    if (!order) return { success: false, error: 'Order not found' };
    return { success: true, order };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function fetchOrderLines(lineIds) {
  try {
    if (!lineIds || !lineIds.length) return { success: true, lines: [] };
    const lines = await callKw(
      'pos.order.line',
      'read',
      [lineIds],
      {
        fields: ['id', 'product_id', 'qty', 'price_unit', 'full_product_name', 'note'],
      },
    );
    return { success: true, lines: lines || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function addLineToOrder({ orderId, productId, qty, price_unit }) {
  try {
    const lineId = await callKw(
      'pos.order.line',
      'create',
      [[{
        order_id: orderId,
        product_id: productId,
        qty,
        price_unit,
      }]],
    );
    return { success: true, lineId };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ── Default Export ────────────────────────────────────────────

export default {
  printKot,
  printReceipt,
  printInvoice,
  getPosConfig,
  loadPosConfig,
  clearPosConfigCache,
  getTables,
  getProducts,
  fetchOrder,
  fetchOrderLines,
  addLineToOrder,
};
