// In-memory product cache: fetch all products once, filter instantly for each category
let _allProductsCache = null;
let _allProductsCacheTime = 0;
let _allProductsCacheDb = null; // tracks which DB the cache belongs to
const PRODUCT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// pos.category cache — categories change far less often than products, and the
// products panel re-mounts on every open. Without this, each open re-fetched
// the full category list over the network.
let _posCategoriesCache = null;
let _posCategoriesCacheTime = 0;
let _posCategoriesCacheDb = null;
const POS_CATEGORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Only products ticked "Available in POS" belong in the POS product list.
// Without this the app pulls every product.template in the database
// (inventory, purchase-only, services), which is not what the POS web
// client shows. Mirrors the domain Odoo's own POS uses on load.
const POS_AVAILABLE_DOMAIN = ['available_in_pos', '=', true];

// Diagnostic logging for product loads. Watch it live with:
//   npm run logcat          (adb logcat -s ReactNativeJS:V ReactNative:V *:E)
// then filter on the [POS-PRODUCTS] tag.
const _posLog = (...args) => console.log('[POS-PRODUCTS]', ...args);

// search_count on product.template — powers the dev-only "N of M" line that
// shows how many records the available_in_pos filter is holding back.
const _countProductTemplates = async (baseUrl, headers, domain) => {
  const res = await axios.post(
    `${baseUrl}/web/dataset/call_kw`,
    {
      jsonrpc: '2.0',
      method: 'call',
      params: { model: 'product.template', method: 'search_count', args: [domain], kwargs: {} },
    },
    { headers }
  );
  if (res.data && res.data.error) throw new Error('search_count failed');
  return res.data.result || 0;
};

// Helper: build headers from AsyncStorage session info
const _buildOdooHeaders = async () => {
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  const { DEFAULT_ODOO_DB, DEFAULT_ODOO_BASE_URL } = require('../config/odooConfig');
  const [deviceUrl, sessionId, deviceDb] = await Promise.all([
    AsyncStorage.getItem('device_server_url'),
    AsyncStorage.getItem('odoo_session_id'),
    AsyncStorage.getItem('device_db_name'),
  ]);
  const baseUrl = (deviceUrl || DEFAULT_ODOO_BASE_URL || '').replace(/\/+$/, '');
  const dbName = deviceDb || DEFAULT_ODOO_DB;
  const headers = { 'Content-Type': 'application/json', 'X-Odoo-Database': dbName };
  if (sessionId) {
    headers['Cookie'] = `session_id=${sessionId}`;
    headers['X-Openerp-Session-Id'] = sessionId;
  }
  return { baseUrl, dbName, headers };
};

// Odoo stores every datetime in UTC and renders it back in the user's timezone.
// The KOT scheduler picks a time in the DEVICE's local timezone, so convert
// local -> UTC before writing preset_time — exactly what the web POS does.
// Without this the raw local time is stored as if it were UTC and the order
// shows shifted by the tz offset (e.g. 12:20 picked -> displayed 17:50 at +5:30).
// dateStr: 'YYYY-MM-DD', timeStr: 'HH:MM' (both local). Returns 'YYYY-MM-DD HH:MM:SS' in UTC.
export const toOdooUtcDatetime = (dateStr, timeStr) => {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  const [hh, mm] = String(timeStr || '').split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const local = new Date(y, m - 1, d, hh, mm, 0, 0); // interpreted in device local tz
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00`;
};

// Helper: filter product list by pos category ID (checks both Many2one and Many2many fields)
const _filterByPosCategory = (products, catId) => {
  if (!catId) return products;
  return products.filter(p => {
    // pos_categ_ids (Many2many, Odoo 16+) — array of integer IDs
    if (Array.isArray(p.pos_categ_ids) && p.pos_categ_ids.length > 0) {
      return p.pos_categ_ids.includes(catId);
    }
    // pos_categ_id (Many2one) — comes as [id, name] or false/integer
    if (Array.isArray(p.pos_categ_id) && p.pos_categ_id.length > 0) {
      return p.pos_categ_id[0] === catId;
    }
    return p.pos_categ_id === catId;
  });
};

// Preload all products into cache
export const preloadAllProducts = async () => {
  const { baseUrl, dbName, headers } = await _buildOdooHeaders();
  // Logged before any network call so the line appears even when the fetch
  // fails — the callers swallow errors, so a silent throw is invisible.
  _posLog(`preload: START -> ${baseUrl} (domain available_in_pos=true)`);
  // Try with pos_categ_ids first (Odoo 16+), fallback to pos_categ_id only
  const doFetch = async (fields) => {
    const response = await axios.post(
      `${baseUrl}/web/dataset/call_kw`,
      {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.template',
          method: 'search_read',
          args: [[POS_AVAILABLE_DOMAIN]],
          kwargs: { fields, limit: 2000, order: 'name asc' },
        },
      },
      { headers }
    );
    if (response.data && response.data.error) {
      throw new Error(response.data.error.data?.message || response.data.error.message || 'Odoo error');
    }
    return response.data.result || [];
  };

  let allProducts;
  // PERFORMANCE FIX: do NOT pull image_128 (base64) in the bulk preload.
  // Each base64 image is 10-50KB; for a 100-product menu that's 5+ MB of
  // JSON over the wire and was the dominant cause of 15s POS Products
  // loads. Images now load lazily via URL when each card renders.
  try {
    // Odoo 16+: only pos_categ_ids (Many2many) exists.
    // product_variant_id = the product.product (variant) id — REQUIRED for the
    // order line's product_id (Odoo expects a variant, not the template id).
    allProducts = await doFetch(['id', 'name', 'pos_categ_ids', 'list_price', 'taxes_id', 'default_code', 'product_variant_id']);
  } catch (e1) {
    _posLog(`preload: tier 1 (pos_categ_ids) failed -> ${e1?.message || e1}`);
    try {
      // Odoo 13-15: only pos_categ_id (Many2one) exists
      allProducts = await doFetch(['id', 'name', 'pos_categ_id', 'list_price', 'taxes_id', 'default_code', 'product_variant_id']);
    } catch (e2) {
      _posLog(`preload: tier 2 (pos_categ_id) failed -> ${e2?.message || e2}`);
      try {
        // Neither field exists — get products without category info
        allProducts = await doFetch(['id', 'name', 'list_price', 'taxes_id', 'default_code', 'product_variant_id']);
      } catch (e3) {
        _posLog(`preload: ALL TIERS FAILED -> ${e3?.message || e3}`);
        throw e3;
      }
    }
  }

  const _preloadTs = Date.now();
  _allProductsCache = allProducts.map(p => {
    // Always lazy-load images via Odoo's binary endpoint — keeps the bulk
    // payload small. FlashList will fetch each image when its card renders.
    const imageUrl = `${baseUrl}/web/image?model=product.template&id=${p.id}&field=image_128&_ts=${_preloadTs}`;
    // variantId = product.product id; p.id stays the template id (for keying,
    // image URL, price map). variantId is what the order line must use.
    const variantId = Array.isArray(p.product_variant_id) ? p.product_variant_id[0] : (p.product_variant_id || null);
    return { ...p, product_name: p.name || '', image_url: imageUrl, variantId };
  });
  _allProductsCacheTime = Date.now();
  _allProductsCacheDb = `${baseUrl}::${dbName}`;

  _posLog(`preload: ${_allProductsCache.length} POS products loaded (available_in_pos=true)`);
  // Dev-only: one extra search_count so the log shows what the filter removed.
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    try {
      const total = await _countProductTemplates(baseUrl, headers, []);
      const kept = _allProductsCache.length;
      _posLog(`preload: filter hid ${total - kept} non-POS products (${kept} of ${total} total product.template)`);
    } catch (_) {
      _posLog('preload: could not read total product count (search_count failed)');
    }
  }

  return _allProductsCache;
};

// Clear product cache
export const clearProductCache = () => {
  _allProductsCache = null;
  _allProductsCacheTime = 0;
  _allProductsCacheDb = null;
};

// Fetch products for a given pos.category ID — uses server-side domain filtering for reliability
export const fetchProductsByPosCategoryId = async (posCategoryId) => {
  if (!posCategoryId) return [];
  const catId = Number(posCategoryId);
  if (!catId) return [];

  const { baseUrl, dbName, headers } = await _buildOdooHeaders();
  // PERFORMANCE: drop image_128 from the bulk fetch — load images lazily by URL.
  // product_variant_id = the product.product (variant) id needed for order lines.
  const baseFields = ['id', 'name', 'list_price', 'default_code', 'product_variant_id'];

  const _ts = Date.now();
  const toProduct = (p) => ({
    ...p,
    product_name: p.name || '',
    image_url: `${baseUrl}/web/image?model=product.template&id=${p.id}&field=image_128&_ts=${_ts}`,
    variantId: Array.isArray(p.product_variant_id) ? p.product_variant_id[0] : (p.product_variant_id || null),
  });

  const doDirectFetch = async (domain, fields) => {
    const response = await axios.post(
      `${baseUrl}/web/dataset/call_kw`,
      {
        jsonrpc: '2.0', method: 'call',
        params: {
          model: 'product.template', method: 'search_read',
          args: [[POS_AVAILABLE_DOMAIN, ...domain]],
          kwargs: { fields, limit: 2000, order: 'name asc' },
        },
      },
      { headers }
    );
    if (response.data && response.data.error) {
      throw new Error(response.data.error.data?.message || response.data.error.message || 'Odoo error');
    }
    return (response.data.result || []).map(toProduct);
  };

  // Tier 1: Odoo 16+ — server-side filter by pos_categ_ids (Many2many)
  try {
    const rows = await doDirectFetch(
      [['pos_categ_ids', 'in', [catId]]],
      [...baseFields, 'pos_categ_ids']
    );
    _posLog(`category ${catId}: ${rows.length} POS products (tier 1, pos_categ_ids)`);
    return rows;
  } catch (_) {}

  // Tier 2: Odoo 13-15 — server-side filter by pos_categ_id (Many2one)
  try {
    const rows = await doDirectFetch(
      [['pos_categ_id', '=', catId]],
      [...baseFields, 'pos_categ_id']
    );
    _posLog(`category ${catId}: ${rows.length} POS products (tier 2, pos_categ_id)`);
    return rows;
  } catch (_) {}

  // Tier 3: Fallback — load all products and filter client-side
  try {
    const cacheKey = `${baseUrl}::${dbName}`;
    const cacheStale = !_allProductsCache
      || (Date.now() - _allProductsCacheTime > PRODUCT_CACHE_TTL)
      || _allProductsCacheDb !== cacheKey;
    if (cacheStale) await preloadAllProducts();
    const rows = _filterByPosCategory(_allProductsCache, catId);
    _posLog(`category ${catId}: ${rows.length} POS products (tier 3, client-side filter of ${_allProductsCache?.length ?? 0} cached)`);
    return rows;
  } catch (_) {
    _posLog(`category ${catId}: all 3 tiers failed, returning 0 products`);
    return [];
  }
};
// Fetch all product categories from Odoo (product.category)
export const fetchProductCategoriesOdoo = async () => {
  try {
    // Use the device's configured server + session, like every other call here.
    // This previously used DEFAULT_ODOO_BASE_URL, which is "" — producing the
    // relative URL "/web/dataset/call_kw". That can never resolve in React
    // Native, so the request failed and the interceptor silently retried it
    // 8 x 1500ms (~12s) while the POS panel sat on "Loading categories...".
    const { baseUrl, headers } = await _buildOdooHeaders();
    const url = `${baseUrl}/web/dataset/call_kw`;
    const response = await axios.post(
      url,
      {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.category',
          method: 'search_read',
          args: [[]],
          kwargs: {
            fields: ['id', 'name', 'parent_id', 'complete_name'],
            order: 'complete_name',
          },
        },
      },
      { headers }
    );
    if (response.data && response.data.error) {
      throw new Error(response.data.error.message || JSON.stringify(response.data.error) || 'Odoo error');
    }
    return response.data.result || [];
  } catch (error) {
    throw error;
  }
};
// Fetch POS categories from Odoo (pos.category) — with field fallbacks for Odoo version compatibility
export const fetchPosCategoriesOdoo = async () => {
  const { DEFAULT_ODOO_DB, DEFAULT_ODOO_BASE_URL } = require('../config/odooConfig');
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  const [deviceUrl, sessionId, deviceDb] = await Promise.all([
    AsyncStorage.getItem('device_server_url'),
    AsyncStorage.getItem('odoo_session_id'),
    AsyncStorage.getItem('device_db_name'),
  ]);
  const baseUrl = (deviceUrl || DEFAULT_ODOO_BASE_URL || '').replace(/\/+$/, '');
  const dbName = deviceDb || DEFAULT_ODOO_DB;
  const url = baseUrl + '/web/dataset/call_kw';
  const headers = { 'Content-Type': 'application/json', 'X-Odoo-Database': dbName };
  if (sessionId) {
    headers['Cookie'] = `session_id=${sessionId}`;
    headers['X-Openerp-Session-Id'] = sessionId;
  }

  const cacheKey = `${baseUrl}::${dbName}`;
  if (_posCategoriesCache
      && (Date.now() - _posCategoriesCacheTime < POS_CATEGORY_CACHE_TTL)
      && _posCategoriesCacheDb === cacheKey) {
    _posLog(`categories: ${_posCategoriesCache.length} from cache (instant)`);
    return _posCategoriesCache;
  }

  const doFetch = async (fields) => {
    const response = await axios.post(url, {
      jsonrpc: '2.0', method: 'call',
      params: {
        model: 'pos.category', method: 'search_read',
        args: [[]],
        kwargs: { fields, order: 'sequence, name' },
      },
    }, { headers });
    if (response.data && response.data.error) {
      throw new Error(response.data.error.data?.message || response.data.error.message || 'Odoo error');
    }
    return response.data.result || [];
  };

  const _t0 = Date.now();
  const _finish = (rows) => {
    // Only cache a non-empty result. Caching [] would pin the category strip
    // on "Loading categories..." for the whole TTL after one bad response.
    if (Array.isArray(rows) && rows.length > 0) {
      _posCategoriesCache = rows;
      _posCategoriesCacheTime = Date.now();
      _posCategoriesCacheDb = cacheKey;
    } else {
      _posLog('categories: empty result — not caching, will retry next open');
    }
    _posLog(`categories: ${rows.length} loaded in ${Date.now() - _t0}ms (no inline images)`);
    return rows;
  };

  // PERFORMANCE: never request image_128/image_512 here. Each pos.category
  // base64 image is 10-200KB; inlining them was making this call take many
  // seconds while the panel showed "Loading categories...". The mapper in
  // fetchCategoriesOdoo already falls back to a /web/image URL, so tiles
  // still show artwork — it just loads lazily per tile instead of up front.
  // (Same fix already applied to the product preload.)
  //
  // This used to be a three-tier ladder, but tier 2 retried with the SAME
  // pos_config_ids that had just failed (its comment claimed otherwise), so on a
  // database without that field both tiers failed identically and every load
  // burned two rejected round-trips before reaching the minimal tier. Ask the
  // model what it has instead of guessing — one request, no failures.
  const wanted = ['id', 'name', 'parent_id', 'sequence', 'pos_config_ids', 'has_image'];
  const fields = await _pruneFieldListForModel('pos.category', wanted, baseUrl, headers, 'categories');
  try {
    return _finish(await doFetch(fields));
  } catch (error) {
    // Only reachable if fields_get failed and we sent the list unpruned.
    _posLog(`categories: failed -> ${error?.message || error} — retrying minimal fields`);
    try {
      return _finish(await doFetch(['id', 'name', 'parent_id', 'sequence']));
    } catch (e2) {
      _posLog(`categories: ALL ATTEMPTS FAILED -> ${e2?.message || e2}`);
      throw e2;
    }
  }
};
// Full workflow: create invoice, post, pay, and log status
export const processInvoiceWithPaymentOdoo = async ({ partnerId, products = [], journalId, invoiceDate = null, reference = '', paymentAmount = null } = {}) => {
  try {
    // Step 0: If journalId is not provided, fetch and select sales journal
    let finalJournalId = journalId;
    if (!finalJournalId) {
      const journals = await fetchPaymentJournalsOdoo();
      const salesJournal = journals.find(j => j.type === 'sale');
      if (!salesJournal) throw new Error('No sales journal found in Odoo.');
      finalJournalId = salesJournal.id;
    }

    // Step 1: Create and post invoice
    const invoiceResult = await createInvoiceOdoo({ partnerId, products, journalId: finalJournalId, invoiceDate, reference });
    if (!invoiceResult.id) {
      throw new Error('Invoice creation failed');
    }
    if (invoiceResult.posted) {
    } else {
      throw new Error('Invoice was created but not posted. Cannot proceed with payment.');
    }

    // Step 2: Register payment for invoice
    let amount = paymentAmount;
    if (amount === null) {
      amount = products.reduce((sum, p) => sum + (p.price || p.price_unit || p.list_price || 0) * (p.quantity || p.qty || 1), 0);
    }

    const paymentResult = await createAccountPaymentOdoo({ partnerId, journalId: finalJournalId, amount, invoiceId: invoiceResult.id });
    if (!paymentResult.result) {
      throw new Error('Payment creation failed');
    }

    // Step 3: Post the payment
    const paymentId = paymentResult.result;
    const postPaymentResponse = await fetch(`${ODOO_BASE_URL}web/dataset/call_kw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'account.payment',
          method: 'action_post',
          args: [[paymentId]],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const postPaymentResult = await postPaymentResponse.json();
    // Step 4: Verify payment reconciliation
    const paymentStatusResponse = await fetch(`${ODOO_BASE_URL}web/dataset/call_kw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'account.payment',
          method: 'search_read',
          args: [[['id', '=', paymentId]]],
          kwargs: { fields: ['id', 'reconciled', 'state', 'invoice_ids'] },
        },
        id: new Date().getTime(),
      }),
    });
    const paymentStatus = await paymentStatusResponse.json();
    const paymentDetails = paymentStatus.result?.[0];
    if (!paymentDetails.reconciled) {
      const reconcileResponse = await fetch(`${ODOO_BASE_URL}web/dataset/call_kw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'account.payment',
            method: 'reconcile',
            args: [[paymentId]],
            kwargs: {},
          },
          id: new Date().getTime(),
        }),
      });
      const reconcileResult = await reconcileResponse.json();
    }

    // Step 5: Verify invoice status
    const invoiceStatusResponse = await fetch(`${ODOO_BASE_URL}web/dataset/call_kw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'account.move',
          method: 'search_read',
          args: [[['id', '=', invoiceResult.id]]],
          kwargs: { fields: ['id', 'payment_state', 'amount_residual'] },
        },
        id: new Date().getTime(),
      }),
    });
    const invoiceStatus = await invoiceStatusResponse.json();
    const updatedInvoice = invoiceStatus.result?.[0];

    if (updatedInvoice.payment_state === 'paid' && updatedInvoice.amount_residual === 0) {
    } else {
      throw new Error('[PROCESS] Invoice payment not fully processed. Check payment state or residual amount.');
    }

    return { invoiceResult, paymentResult, invoiceStatus: updatedInvoice };
  } catch (error) {
    return { error };
  }
};
// Validate POS order in Odoo to trigger name generation
export const validatePosOrderOdoo = async (orderId) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'action_pos_order_paid',
          args: [[orderId]],
          kwargs: {},
        },
      }),
    });
    const data = await response.json();
    if (data && data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};
// Fetch POS registers (configurations) from Odoo
export const fetchPOSRegisters = async ({ limit = 20, offset = 0 } = {}) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.config',
          method: 'search_read',
          args: [[]],
          kwargs: {
            fields: ['id', 'name'],
            limit,
            offset,
            order: 'id desc',
          },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      throw new Error('Odoo JSON-RPC error');
    }
    return data.result || [];
  } catch (error) {
    throw error;
  }
};
// Fetch POS sessions (registers) from Odoo
export const fetchPOSSessions = async ({ limit = 20, offset = 0, state = '' } = {}) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    let domain = [];
    if (state) {
      domain = [['state', '=', state]];
    }
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.session',
          method: 'search_read',
          args: [domain],
          kwargs: {
            fields: [
              'id',
              'name',
              'state',
              'user_id',
              'start_at',
              'stop_at',
              'cash_register_balance_end',
              'cash_register_balance_start',
              'config_id',
            ],
            limit,
            offset,
            order: 'id desc',
          },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      throw new Error('Odoo JSON-RPC error');
    }
    return data.result || [];
  } catch (error) {
    throw error;
  }
};
// api/services/generalApi.js
import axios from "axios";
import ODOO_BASE_URL from '@api/config/odooConfig';
import { odooLogin } from './odooAuth';
import AsyncStorage from '@react-native-async-storage/async-storage';


import { get } from "./utils";
import { API_ENDPOINTS } from "@api/endpoints";
import { useAuthStore } from '@stores/auth';
import handleApiError from "../utils/handleApiError";

// Debugging output for useAuthStore
export const fetchProducts = async ({ offset, limit, categoryId, searchText }) => {
  try {
    const queryParams = {
      ...(searchText !== undefined && { product_name: searchText }),
      offset,
      limit,
      ...(categoryId !== undefined && { category_id: categoryId }),
    };
    // Debugging output for queryParams
    const response = await get(API_ENDPOINTS.VIEW_PRODUCTS, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};



// 🔹 Fetch products from Odoo — uses cache for category lookups, direct API for search/all
export const fetchProductsOdoo = async ({ offset, limit, searchText, categoryId, posCategoryId } = {}) => {
  const catId = Number(posCategoryId) || Number(categoryId);

  // When a category is requested, use the cached all-products approach for reliability
  if (catId) {
    try {
      const { baseUrl: curUrl, dbName: curDb } = await _buildOdooHeaders();
      const curKey = `${curUrl}::${curDb}`;
      if (!_allProductsCache || (Date.now() - _allProductsCacheTime > PRODUCT_CACHE_TTL) || _allProductsCacheDb !== curKey) {
        await preloadAllProducts();
      }
      let filtered = _filterByPosCategory(_allProductsCache, catId);
      if (searchText && searchText.trim()) {
        const term = searchText.trim().toLowerCase();
        filtered = filtered.filter(p => (p.product_name || p.name || '').toLowerCase().includes(term));
      }
      _posLog(`list: ${filtered.length} POS products (from cache, category ${catId}${searchText ? `, search "${searchText}"` : ''})`);
      return filtered;
    } catch (cacheErr) {
      // cache fetch failed — fall through to direct fetch below
    }
  }

  // Direct API fetch (no category, or cache failed)
  const { baseUrl, headers } = await _buildOdooHeaders();

  const textDomain = (searchText && searchText.trim()) ? [["name", "ilike", searchText.trim()]] : [];
  // Fetch more records when filtering by category client-side
  const fetchLimit = catId ? 500 : (limit || 50);
  const fetchOffset = catId ? 0 : (offset || 0);

  const doDirectFetch = async (fields) => {
    const response = await axios.post(
      `${baseUrl}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "product.template",
          method: "search_read",
          args: [[POS_AVAILABLE_DOMAIN, ...textDomain]],
          kwargs: {
            fields,
            limit: fetchLimit,
            offset: fetchOffset,
            order: "name asc",
          },
        },
      },
      { headers }
    );
    if (response.data && response.data.error) {
      throw new Error(response.data.error.data?.message || response.data.error.message || 'Odoo error');
    }
    return response.data.result || [];
  };

  let products;
  try {
    // Odoo 16+: pos_categ_ids only. product_variant_id = the variant id for order lines.
    products = await doDirectFetch(["id", "name", "list_price", "default_code", "uom_id", "image_128", "pos_categ_ids", "product_variant_id"]);
  } catch (e1) {
    try {
      // Odoo 13-15: pos_categ_id only
      products = await doDirectFetch(["id", "name", "list_price", "default_code", "uom_id", "image_128", "pos_categ_id", "product_variant_id"]);
    } catch (e2) {
      // Neither field — get products without category info
      products = await doDirectFetch(["id", "name", "list_price", "default_code", "uom_id", "image_128", "product_variant_id"]);
    }
  }

  // Apply client-side category filter if needed (cache was unavailable)
  const _fetchedCount = products.length;
  if (catId) {
    products = _filterByPosCategory(products, catId);
  }
  _posLog(
    `list: ${products.length} POS products (direct fetch` +
    (catId ? `, category ${catId} narrowed from ${_fetchedCount}` : '') +
    (searchText && searchText.trim() ? `, search "${searchText.trim()}"` : '') +
    `, limit ${fetchLimit}, offset ${fetchOffset})`
  );

  const _fetchTs = Date.now();
  return products.map((p) => {
    const hasBase64 = p.image_128 && typeof p.image_128 === 'string' && p.image_128.length > 0;
    const imageUrl = hasBase64
      ? `data:image/png;base64,${p.image_128}`
      : `${baseUrl}/web/image?model=product.template&id=${p.id}&field=image_128&_ts=${_fetchTs}`;
    return {
      id: p.id,
      product_name: p.name || "",
      image_url: imageUrl,
      price: p.list_price || 0,
      code: p.default_code || "",
      uom: p.uom_id ? { uom_id: p.uom_id[0], uom_name: p.uom_id[1] } : null,
      variantId: Array.isArray(p.product_variant_id) ? p.product_variant_id[0] : (p.product_variant_id || null),
    };
  });
};

// Legacy retry wrapper — kept for backward compat but no longer used by fetchProductsOdoo
const _legacyUnused = async () => {
  let retried = false;
  while (true) {
    try {
      return;
    } catch (error) {
      const isSessionExpired = error && (error.message === 'Session expired' || error.name === 'odoo.http.SessionExpiredException');
      if (isSessionExpired && !retried) {
        retried = true;
        try {
          const username = await AsyncStorage.getItem('odoo_username');
          const password = await AsyncStorage.getItem('odoo_password');
          if (username && password) {
            const loginResult = await odooLogin(username, password);
            if (loginResult.success) {
              continue;
            } else {
              throw new Error('Odoo re-login failed: ' + (loginResult.error?.message || loginResult.error));
            }
          } else {
            throw new Error('No Odoo credentials stored for auto-login.');
          }
        } catch (loginErr) {
          throw loginErr;
        }
      } else {
        // Not a session error or already retried
        throw error;
      }
    }
  }
};
// Ensure this points to your Odoo URL

// Fetch categories directly from Odoo using JSON-RPC
// NOTE: older code filtered by a non-existent `is_category` field which caused Odoo to raise
// "Invalid field product.category.is_category". Use a safe domain (empty) and apply
// `name ilike` only when a searchText is provided.
export const fetchCategoriesOdoo = async ({ offset = 0, limit = 50, searchText = "" } = {}) => {
  try {
    // Fetch POS-specific categories only (pos.category)
    const [posCats, { baseUrl }] = await Promise.all([fetchPosCategoriesOdoo(), _buildOdooHeaders()]);
    if (!Array.isArray(posCats) || posCats.length === 0) return [];

    const _catTs = Date.now();
    const term = searchText && searchText.trim() ? searchText.trim().toLowerCase() : null;
    let filtered = term ? posCats.filter(c => (c.name || '').toLowerCase().includes(term)) : posCats;

    // Apply offset & limit
    const sliced = filtered.slice(offset, offset + limit);

    return sliced.map(category => ({
      _id: category.id,
      name: category.name || '',
      complete_name: category.complete_name || category.name || '',
      parent: Array.isArray(category.parent_id) ? { id: category.parent_id[0], name: category.parent_id[1] } : null,
      children: Array.isArray(category.child_ids) ? category.child_ids : (Array.isArray(category.child_id) ? category.child_id : []),
      product_count: Number(category.product_count || 0),
      has_image: !!category.has_image || !!category.image_128 || !!category.image_512,
      // Prefer inline base64 images when present; otherwise provide a cache-busted web/image URL fallback
      image: (category.image_128 && typeof category.image_128 === 'string' && category.image_128.length > 0)
        ? `data:image/png;base64,${category.image_128}`
        : ((category.image_512 && typeof category.image_512 === 'string' && category.image_512.length > 0)
            ? `data:image/png;base64,${category.image_512}`
            : `${baseUrl}/web/image?model=pos.category&id=${category.id}&field=image_128&_ts=${_catTs}`),
      pos_config_ids: Array.isArray(category.pos_config_ids) ? category.pos_config_ids : [],
      sequence: category.sequence || 0,
      hour_after: category.hour_after ?? null,
      hour_until: category.hour_until ?? null,
      color: category.color ?? null,
      category_name: category.name || '',
    }));
  } catch (error) {
    throw error;
  }
};

// Fetch detailed product information for a single Odoo product id
export const fetchProductDetailsOdoo = async (productId) => {
  try {
    if (!productId) return null;

    // 1. Fetch product details
    const productResponse = await axios.post(
      `${ODOO_BASE_URL}/web/dataset/call_kw`,
      {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.template',
          method: 'search_read',
          args: [[['id', '=', productId]]],
          kwargs: {
            fields: [
              'id', 'name', 'list_price', 'default_code', 'uom_id', 'image_128',
              'description_sale', 'categ_id', 'qty_available', 'virtual_available'
            ],
            limit: 1,
          },
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (productResponse.data.error) throw new Error('Odoo JSON-RPC error');
    const results = productResponse.data.result || [];
    const p = results[0];
    if (!p) return null;

    // 2. Fetch warehouse/stock info
    const quantResponse = await axios.post(
      `${ODOO_BASE_URL}/web/dataset/call_kw`,
      {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'stock.quant',
          method: 'search_read',
          args: [[['product_id', '=', productId]]],
          kwargs: {
            fields: ['location_id', 'quantity'],
          },
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    let inventory_ledgers = [];
    if (quantResponse.data && quantResponse.data.result) {
      inventory_ledgers = quantResponse.data.result.map(q => ({
        warehouse_id: Array.isArray(q.location_id) ? q.location_id[0] : null,
        warehouse_name: Array.isArray(q.location_id) ? q.location_id[1] : '',
        total_warehouse_quantity: q.quantity,
      }));
    }

    // 3. Shape and return
    const hasBase64 = p.image_128 && typeof p.image_128 === 'string' && p.image_128.length > 0;
    const baseUrl = (ODOO_BASE_URL || '').replace(/\/$/, '');
    const imageUrl = hasBase64
      ? `data:image/png;base64,${p.image_128}`
      : `${baseUrl}/web/image?model=product.template&id=${p.id}&field=image_128`;

    return {
      id: p.id,
      product_name: p.name || '',
      image_url: imageUrl,
      price: p.list_price || 0,
      minimal_sales_price: p.list_price || null,
      inventory_ledgers,
      total_product_quantity: p.qty_available ?? p.virtual_available ?? 0,
      inventory_box_products_details: [],
      product_code: p.default_code || null,
      uom: p.uom_id ? { uom_id: p.uom_id[0], uom_name: p.uom_id[1] } : null,
      categ_id: p.categ_id || null,
      product_description: p.description_sale || null,
    };
  } catch (error) {
    throw error;
  }
};


export const fetchInventoryBoxRequest = async ({ offset, limit, searchText }) => {
  const currentUser = useAuthStore.getState().user; // Correct usage of useAuthStore
  const salesPersonId = currentUser.related_profile._id;

  // Debugging output for salesPersonId
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { name: searchText }),
      ...(salesPersonId !== undefined && { sales_person_id: salesPersonId })
    };
    const response = await get(API_ENDPOINTS.VIEW_INVENTORY_BOX_REQUEST, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchAuditing = async ({ offset, limit }) => {
  try {
    const queryParams = {
      offset,
      limit,
    };
    const response = await get(API_ENDPOINTS.VIEW_AUDITING, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchCustomers = async ({ offset, limit, searchText }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { name: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_CUSTOMERS, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};// 🔹 Fetch customers directly from Odoo 19 via JSON-RPC (no mobile field)
export const fetchCustomersOdoo = async ({ offset = 0, limit = 50, searchText } = {}) => {
  try {
    // 🔍 Domain for search (optional)
    let domain = [];

    if (searchText && searchText.trim() !== "") {
      const term = searchText.trim();
      domain = [
        "|",
        ["name", "ilike", term],
        ["phone", "ilike", term],
      ];
    }
const response = await axios.post(
  `${ODOO_BASE_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "res.partner",
          method: "search_read",
          args: [domain],
          kwargs: {
            fields: [
              "id", "name", "email", "phone",
              "street", "street2", "city", "zip", "country_id"
            ],
            offset,
            limit,
            order: "name asc",
          },
        },
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    if (response.data.error) {
      throw new Error("Odoo JSON-RPC error");
    }

    const partners = response.data.result || [];

    // 🔙 Shape result for your CustomerScreen
    return partners.map((p) => ({
      id: p.id,
      name: p.name || "",
      email: p.email || "",
      phone: p.phone || "",
      address: [
        p.street,
        p.street2,
        p.city,
        p.zip,
        p.country_id && Array.isArray(p.country_id) ? p.country_id[1] : ""
      ].filter(Boolean).join(", "),
    }));
  } catch (error) {
    throw error;
  }
};


export const fetchPickup = async ({ offset, limit, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
    };
    const response = await get(API_ENDPOINTS.VIEW_PICKUP, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchService = async ({ offset, limit, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
    };
    const response = await get(API_ENDPOINTS.VIEW_SERVICE, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchSpareParts = async ({ offset, limit, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
    };
    const response = await get(API_ENDPOINTS.VIEW_SPARE_PARTS, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchMarketStudy = async ({ offset, limit }) => {
  try {
    const queryParams = {
      offset,
      limit,
    };
    const response = await get(API_ENDPOINTS.VIEW_MARKET_STUDY, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchCustomerVisitList = async ({ offset, limit, fromDate, toDate, customerId, customerName, employeeName, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
      ...(customerName !== undefined && { customer_name: customerName }),
      ...(customerId !== undefined && { customer_id: customerId }),
      ...(employeeName !== undefined && { employee_name: employeeName }),
      ...(fromDate !== undefined && { from_date: fromDate }),
      ...(toDate !== undefined && { to_date: toDate }),
    };
    const response = await get(API_ENDPOINTS.VIEW_CUSTOMER_VISIT_LIST, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchEnquiryRegister = async ({ offset, limit, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
    };
    const response = await get(API_ENDPOINTS.VIEW_ENQUIRY_REGISTER, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchPurchaseRequisition = async ({ offset, limit,searchText}) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { sequence_no: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_PURCHASE_REQUISITION,queryParams);
    return response.data;

  } catch(error){
    handleApiError(error);
    throw error;
  }
}

export const fetchPriceEnquiry = async ({ offset, limit,searchText}) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { sequence_no: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_PRICE,queryParams);
    return response.data;

  } catch(error){
    handleApiError(error);
    throw error;
  }
}

export const fetchPurchaseOrder = async ({ offset, limit,searchText}) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { sequence_no: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_PURCHASE_ORDER,queryParams);
    return response.data;

  } catch(error){
    handleApiError(error);
    throw error;
  }
}

export const fetchDeliveryNote = async ({ offset, limit,searchText}) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { sequence_no: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_DELIVERY_NOTE,queryParams);
    return response.data;

  } catch(error){
    handleApiError(error);
    throw error;
  }
}

export const fetchVendorBill = async ({ offset, limit,searchText}) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { sequence_no: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_VENDOR_BILL,queryParams);
    return response.data;

  } catch(error){
    handleApiError(error);
    throw error;
  }
}

export const fetchPaymentMade = async ({ offset, limit,searchText}) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { sequence_no: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_PAYMENT_MADE,queryParams);
    return response.data;

  } catch(error){
    handleApiError(error);
    throw error;
  }
}

// viewPaymentMade

export const fetchLead = async ({ offset, limit, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
      // ...(sequenceNo !== undefined && { sequence_no: sequenceNo }),
    };
    const response = await get(API_ENDPOINTS.VIEW_LEAD, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchPipeline = async ({ offset, limit, date, source, opportunity, customer, loginEmployeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(date !== undefined && { date: date }),
      ...(source !== undefined && { source_name: source }),
      ...(opportunity !== undefined && { opportunity_name: opportunity }),
      ...(customer !== undefined && { customer_name: customer }),
      ...(loginEmployeeId !== undefined && { login_employee_id: loginEmployeeId }),
    };
    const response = await get(API_ENDPOINTS.VIEW_PIPELINE, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchVisitPlan = async ({ offset, limit, date, employeeId }) => {
  try {
    const queryParams = {
      offset,
      limit,
      date: date,
      ...(employeeId !== undefined && { employee_id: employeeId }),
    };
    const response = await get(API_ENDPOINTS.VIEW_VISIT_PLAN, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchBoxInspectionReport = async ({ offset, limit }) => {
  try {
    const queryParams = {
      offset,
      limit,
    };
    const response = await get(API_ENDPOINTS.VIEW_BOX_INSPECTION_REPORT, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchAttendance = async ({ userId, date }) => {
  try {
    const queryParams = {
      user_id: userId,
      date,
    };
    const response = await get(API_ENDPOINTS.VIEW_ATTENDANCE, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

export const fetchKPIDashboard = async ({ userId }) => {
  try {
    const queryParams = { login_employee_id: userId };
    const response = await get(API_ENDPOINTS.VIEW_KPI, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
}

export const fetchVehicles = async ({ offset, limit, searchText }) => {
  try {
    const queryParams = {
      offset,
      limit,
      ...(searchText !== undefined && { name: searchText }),
    };
    const response = await get(API_ENDPOINTS.VIEW_VEHICLES, queryParams);
    return response.data;
  } catch (error) {
    handleApiError(error);
    throw error;
  }
};

// Fetch full customer/partner details (address fields) by id from Odoo
export const fetchCustomerDetailsOdoo = async (partnerId) => {
  try {
    if (!partnerId) return null;
    const response = await axios.post(
      `${ODOO_BASE_URL}/web/dataset/call_kw`,
      {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'res.partner',
          method: 'search_read',
          args: [[['id', '=', partnerId]]],
          kwargs: {
            fields: ['id', 'name', 'street', 'street2', 'city', 'zip', 'country_id'],
            limit: 1,
          },
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data.error) {
      throw new Error('Odoo JSON-RPC error');
    }

    const results = response.data.result || [];
    const p = results[0];
    if (!p) return null;

    const address = [p.street, p.street2, p.city, p.zip, p.country_id && Array.isArray(p.country_id) ? p.country_id[1] : '']
      .filter(Boolean)
      .join(', ');

    return {
      id: p.id,
      name: p.name || '',
      address: address || null,
    };
  } catch (error) {
    throw error;
  }
};

// Create Account Payment for Odoo
export const createAccountPaymentOdoo = async ({ partnerId, journalId, amount, invoiceId = null } = {}) => {
  try {
    const params = {
      partner_id: partnerId,
      journal_id: journalId,
      amount,
      payment_type: 'inbound', // Customer payment
      partner_type: 'customer', // Payment from a customer
    };

    // Include invoice_ids to link the payment to the invoice
    if (invoiceId) {
      params.invoice_ids = [[6, 0, [invoiceId]]];
    }

    const payload = {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model: 'account.payment',
        method: 'create',
        args: [params],
        kwargs: {},
      },
      id: new Date().getTime(),
    };

    const response = await fetch(`${ODOO_BASE_URL}web/dataset/call_kw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    // Post the payment to finalize it
    if (result.result) {
      const paymentId = result.result;
      await fetch(`${ODOO_BASE_URL}web/dataset/call_kw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'account.payment',
            method: 'action_post',
            args: [[paymentId]],
            kwargs: {},
          },
          id: new Date().getTime(),
        }),
      });
    }

    return result;
  } catch (error) {
    return { error };
  }
};

// Fetch Payment Journals for Odoo
export const fetchPaymentJournalsOdoo = async () => {
  try {
    const response = await axios.post(
      `${ODOO_BASE_URL}/web/dataset/call_kw`,
      {
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "account.journal",
          method: "search_read",
          args: [[]],
          kwargs: {
            fields: ["id", "name", "type"],
            limit: 20,
          },
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );
    if (response.data && response.data.result) return response.data.result;
    return [];
  } catch (error) {
    return [];
  }
};

// Fetch all pricelists from Odoo
export const fetchPricelistsOdoo = async () => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.pricelist',
          method: 'search_read',
          args: [[]],
          kwargs: { fields: ['id', 'name'], limit: 50 },
        },
      }),
    });
    const data = await response.json();
    return data?.result || [];
  } catch (e) {
    return [];
  }
};

// Fetch pricelist items (per-product prices) for a specific pricelist
export const fetchPricelistItemsOdoo = async (pricelistId) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.pricelist.item',
          method: 'search_read',
          args: [[['pricelist_id', '=', pricelistId]]],
          kwargs: { fields: ['id', 'product_tmpl_id', 'product_id', 'fixed_price', 'compute_price', 'percent_price'], limit: 500 },
        },
      }),
    });
    const data = await response.json();
    return data?.result || [];
  } catch (e) {
    return [];
  }
};

// Fetch all POS payment methods from Odoo (Cash, Card, Talabat, Bank Transfer, etc.)
export const fetchPosPaymentMethodsOdoo = async () => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.payment.method',
          method: 'search_read',
          args: [[]],
          kwargs: { fields: ['id', 'name', 'journal_id', 'is_cash_count'], limit: 50 },
        },
      }),
    });
    const data = await response.json();
    return data?.result || [];
  } catch (e) {
    return [];
  }
};

// Fetch payment method ID for a given journal ID
export const fetchPaymentMethodIdOdoo = async (journalId) => {
  try {
    const response = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model: 'pos.payment.method',
        method: 'search_read',
        args: [[['journal_id', '=', journalId]]],
        kwargs: { fields: ['id', 'name', 'journal_id'], limit: 1 },
      },
    }, { headers: { 'Content-Type': 'application/json' } });
    return response.data?.result?.[0]?.id || null;
  } catch (e) {
    return null;
  }
};

// Create invoice (account.move) in Odoo
export const createInvoiceOdoo = async ({ partnerId, products = [], journalId = null, invoiceDate = null, reference = '' } = {}) => {
  try {
    if (!partnerId) throw new Error('partnerId is required');

    // Ensure we have a valid journal_id. If not provided, auto-select the sales journal.
    let finalJournalId = journalId;
    if (!finalJournalId) {
      try {
        const journals = await fetchPaymentJournalsOdoo();
        const salesJournal = journals.find(j => j.type === 'sale');
        if (salesJournal) {
          finalJournalId = salesJournal.id;
        } else {
        }
      } catch (err) {
      }
    }

    // Build invoice lines and log each line's tax/price
    let totalUntaxed = 0;
    let totalTax = 0;
    const invoice_lines = products.map((p) => {
      const price_unit = p.price || p.price_unit || p.list_price || 0;
      const quantity = p.quantity || p.qty || 1;
      const vals = {
        product_id: p.id,
        name: p.name || p.product_name || '',
        quantity,
        price_unit,
      };
      // taxes: if provided as array of ids
      if (p.tax_ids && Array.isArray(p.tax_ids) && p.tax_ids.length) {
        vals.tax_ids = [[6, 0, p.tax_ids]];
        // For diagnosis, log tax_ids
      }
      // For diagnosis, log price and quantity
      totalUntaxed += price_unit * quantity;
      // Note: Odoo will compute tax, but log if tax_ids present
      if (p.tax_ids && Array.isArray(p.tax_ids) && p.tax_ids.length) {
        // This is a placeholder; actual tax calculation is done by Odoo
        totalTax += 0; // You may add your own calculation if needed
      }
      return [0, 0, vals];
    });

    // Include journal_id only if we have a valid id (avoid sending null)
    const moveVals = {
      partner_id: partnerId,
      move_type: 'out_invoice',
      invoice_line_ids: invoice_lines,
    };
    if (finalJournalId) moveVals.journal_id = finalJournalId;
    if (invoiceDate) moveVals.invoice_date = invoiceDate;
    if (reference) moveVals.ref = reference;

    // Log computed totals before sending
    // Create the account.move record
    const createResp = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model: 'account.move',
        method: 'create',
        args: [moveVals],
        kwargs: {},
      },
    }, { headers: { 'Content-Type': 'application/json' } });
    const createdId = createResp.data && createResp.data.result;
    // Fetch and log the created move record and its lines for diagnosis
    if (createdId) {
      try {
        const moveResp = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'account.move',
            method: 'search_read',
            args: [[['id', '=', createdId]]],
            kwargs: { fields: ['id', 'state', 'move_type', 'journal_id', 'invoice_date', 'payment_state', 'amount_total', 'amount_residual', 'company_id', 'partner_id', 'invoice_line_ids'] },
          },
          id: new Date().getTime(),
        }, { headers: { 'Content-Type': 'application/json' } });
      } catch (moveFetchErr) {
      }
      try {
        const linesResp = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'account.move.line',
            method: 'search_read',
            args: [[['move_id', '=', createdId]]],
            kwargs: { fields: ['id', 'move_id', 'product_id', 'name', 'quantity', 'price_unit', 'account_id', 'tax_ids'] },
          },
          id: new Date().getTime(),
        }, { headers: { 'Content-Type': 'application/json' } });
      } catch (linesFetchErr) {
      }
    }
    // Do not post the invoice here; leave it in draft state until explicitly posted later
    let posted = false;
    // Fetch final invoice status (payment_state, state, amount_residual, amount_total) for diagnostics
    let invoiceStatus = null;
    if (createdId) {
      try {
        const statusResp = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'account.move',
            method: 'search_read',
            args: [[['id', '=', createdId]]],
            kwargs: { fields: ['id', 'state', 'move_type', 'payment_state', 'amount_residual', 'amount_total', 'invoice_date'] },
          },
        }, { headers: { 'Content-Type': 'application/json' } });
        invoiceStatus = statusResp.data && statusResp.data.result && statusResp.data.result[0];
      } catch (statusErr) {
      }
    }

    return { id: createdId, posted, invoiceStatus };
  } catch (error) {
    throw error;
  }
};

// Link an account.move (invoice) to a pos.order and optionally set its state to a specific value
export const linkInvoiceToPosOrderOdoo = async ({ orderId, invoiceId, setState = true, state = null } = {}) => {
  try {
    if (!orderId) throw new Error('orderId is required');
    if (!invoiceId) throw new Error('invoiceId is required');

    // Only link the invoice, do not change the order state
    const vals = { account_move: invoiceId };

    const resp = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model: 'pos.order',
        method: 'write',
        args: [[orderId], vals],
        kwargs: {},
      },
    }, { headers: { 'Content-Type': 'application/json' } });

    // Verify update by reading the order
    try {
      const verify = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'search_read',
          args: [[['id', '=', orderId]]],
          kwargs: { fields: ['id', 'state', 'account_move'] },
        },
      }, { headers: { 'Content-Type': 'application/json' } });
    } catch (verifyErr) {
    }

    return resp.data;
  } catch (error) {
    return { error };
  }
};

// The field list of an Odoo model on THIS database, fetched once per model.
//
// Odoo rejects a create/write/search_read outright if the payload names any
// field the model does not have, and the field set depends on which modules are
// installed: table_id only exists with pos_restaurant, order_type only with the
// custom module, client_uuid only where the idempotency patch is applied.
// Hardcoding a payload therefore breaks on any database whose module set
// differs — 'Invalid field table_id in pos.order' is exactly that.
//
// Fails OPEN: if fields_get itself fails we return [] and callers send the
// payload unpruned. A diagnostic beats silently dropping every field on a
// transient network error.
const _MODEL_FIELD_PROBES = {
  'pos.order': ['table_id', 'preset_id', 'preset_time', 'order_type', 'floating_order_name', 'internal_note', 'client_uuid'],
  'pos.payment': ['client_uuid', 'session_id', 'company_id', 'partner_id'],
};

const _getModelFields = async (model, baseUrl, headers) => {
  if (!global.__odoo_fields_cache) global.__odoo_fields_cache = {};
  const cache = global.__odoo_fields_cache;
  if (Array.isArray(cache[model])) return cache[model];
  try {
    const resp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model, method: 'fields_get', args: [], kwargs: {} } }),
    });
    const data = await resp.json();
    cache[model] = data && data.result ? Object.keys(data.result) : [];
    // One-time capability line per model: which optional fields this database
    // actually has. This is what identifies a module-set mismatch on sight.
    const probe = _MODEL_FIELD_PROBES[model] || [];
    if (probe.length) {
      const present = probe.filter((f) => cache[model].includes(f));
      const absent = probe.filter((f) => !cache[model].includes(f));
      _posLog(`${model} fields: ${cache[model].length} total | present=[${present.join(',')}] | ABSENT=[${absent.join(',')}]`);
    } else {
      _posLog(`${model} fields: ${cache[model].length} total`);
    }
  } catch (e) {
    cache[model] = [];
    _posLog(`${model} fields_get failed -> ${e?.message || e} (payloads sent unpruned)`);
  }
  return cache[model];
};

// Drop keys the model does not have, so one unsupported field cannot reject the
// whole create. Logs what it removed — silent pruning would hide real drift.
//
// `required` names fields the record is meaningless without. Pruning is only
// ever correct for OPTIONAL fields: if a required one is missing from the model
// something is wrong that dropping it would only hide, so this throws instead of
// writing a half-valid record.
const _pruneValsForModel = async (model, vals, baseUrl, headers, label, required = []) => {
  const valid = await _getModelFields(model, baseUrl, headers);
  if (!Array.isArray(valid) || valid.length === 0) return vals;
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(vals)) {
    if (valid.includes(k)) kept[k] = v;
    else dropped.push(k);
  }
  const lostRequired = required.filter((f) => dropped.includes(f));
  if (lostRequired.length) {
    throw new Error(`${model} is missing required field(s) [${lostRequired.join(', ')}] on this database — refusing to create an incomplete record`);
  }
  if (dropped.length) _posLog(`${label}: dropped field(s) not on ${model} -> [${dropped.join(', ')}]`);
  return kept;
};

// Same guard for the READ side. A search_read naming a missing field is
// rejected whole, and callers that do `(resp.result) || []` then render the
// failure as "no orders" — which is how a broken fetch looked like an empty
// session. Prune the requested fields so the read degrades to fewer columns
// instead of no rows.
const _pruneFieldListForModel = async (model, fields, baseUrl, headers, label) => {
  const valid = await _getModelFields(model, baseUrl, headers);
  if (!Array.isArray(valid) || valid.length === 0) return fields;
  const kept = fields.filter((f) => valid.includes(f));
  const dropped = fields.filter((f) => !valid.includes(f));
  if (dropped.length) _posLog(`${label}: not reading field(s) absent from ${model} -> [${dropped.join(', ')}]`);
  return kept.length > 0 ? kept : ['id'];
};

// Public alias so other services (kotService) share this guard instead of
// growing their own copy — a duplicated payment path is what let 'Invalid field
// client_uuid' survive a fix to the shared helper. One implementation.
export const pruneFieldsForModel = _pruneFieldListForModel;

// Create POS order in Odoo via JSON-RPC
// preset_id defaults to undefined (not the old hardcoded 10) so an unset preset
// leaves the field off the payload entirely — see resolveTakeawayPresetId.
export const createPosOrderOdoo = async ({ partnerId = null, lines = [], sessionId = null, posConfigId = null, companyId = null, orderName = null, preset_id = undefined, order_type = null, clientUuid = null } = {}) => {
  try {
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      throw new Error('lines are required to create pos order');
    }

    const { generateUUIDv4 } = require('../../utils/uuid');
    const idempotencyKey = clientUuid || generateUUIDv4();

    const { baseUrl, headers } = await _buildOdooHeaders();

    // Build lines entries for Odoo POS order
    const line_items = lines.map(l => {
      const price_unit = l.price || l.price_unit || l.list_price || 0;
      const qty = l.qty || l.quantity || 1;
      const subtotal = price_unit * qty;
      return [0, 0, {
        // Prefer the explicit product.product (variant) id; fall back to
        // remoteId (server product_id) then the template id as last resort.
        product_id: l.product_id || l.remoteId || l.id,
        qty,
        price_unit,
        name: l.name || l.product_name || '',
        price_subtotal: subtotal,
        price_subtotal_incl: subtotal,
      }];
    });

    // Calculate total
    const amount_total = lines.reduce((sum, l) => sum + (l.price || l.price_unit || l.list_price || 0) * (l.qty || l.quantity || 1), 0);
    const vals = {
      company_id: companyId || 1,
      name: orderName || '/',
      client_uuid: idempotencyKey,
      partner_id: partnerId || false,
      lines: line_items,
      amount_tax: 0,
      amount_total,
      amount_paid: amount_total,
      amount_return: 0,
      state: 'paid',
    };
    if (order_type) vals.order_type = String(order_type).toUpperCase();
    if (sessionId) vals.session_id = sessionId;
    if (posConfigId) vals.config_id = posConfigId;
    if (preset_id !== undefined && preset_id !== null) vals.preset_id = preset_id;

    // Prune once, at the end, so every optional field is covered rather than
    // just order_type.
    const safeVals = await _pruneValsForModel('pos.order', vals, baseUrl, headers, 'createPosOrderOdoo', ['session_id']);

    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'create',
          args: [safeVals],
          kwargs: {},
        },
      }),
    });
    const data = await response.json();

    if (data && data.error) {
      return { error: data.error };
    }

    const createdId = data.result;
    // Immediately validate the order to trigger name generation
    const validateResp = await validatePosOrderOdoo(createdId);
    if (validateResp && validateResp.error) {
      return { result: createdId, error: validateResp.error };
    }
    return { result: createdId };
  } catch (error) {
    return { error };
  }
};

// Create POS payment(s) in Odoo via JSON-RPC
// Accepts either a single payment or an array of payments.
// `clientUuid`: idempotency key — a retry/double-tap with the same UUID will
// return the existing pos.payment instead of creating a duplicate (requires
// pos_idempotent_create v19.0.3.0.0+ on Odoo).
export const createPosPaymentOdoo = async ({ orderId, payments, amount, journalId, paymentMethodId, paymentMode = 'cash', partnerId = null, sessionId = null, companyId = null, clientUuid = null } = {}) => {
  try {
    if (!orderId) throw new Error('orderId is required');

    const { generateUUIDv4 } = require('../../utils/uuid');
    const baseUuid = clientUuid || generateUUIDv4();

    const { baseUrl, headers } = await _buildOdooHeaders();

    // Support both legacy (amount) and new (payments array) API
    let paymentRecords = [];
    if (Array.isArray(payments) && payments.length > 0) {
      paymentRecords = payments;
    } else if (typeof amount !== 'undefined') {
      paymentRecords = [{ amount: Number(amount), journalId, paymentMethodId, paymentMode }];
    } else {
      throw new Error('No payment(s) provided');
    }

    const results = [];
    for (let pmtIdx = 0; pmtIdx < paymentRecords.length; pmtIdx++) {
      const payment = paymentRecords[pmtIdx];
      const amt = Number(payment.amount) || 0;
      if (amt === 0) continue;
      // Per-payment idempotency key: split flag for split-tender so each line
      // is its own dedup target, but a retry of the same line uses the same UUID.
      const lineUuid = paymentRecords.length > 1 ? `${baseUuid}::${pmtIdx}` : baseUuid;

      let finalPaymentMethodId = payment.paymentMethodId || paymentMethodId;
      let finalJournalId = payment.journalId || journalId;

      // If paymentMethodId is not provided, fetch it using journalId
      if (!finalPaymentMethodId) {
        if (!finalJournalId) throw new Error('paymentMethodId or journalId is required');
        const pmResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
          method: 'POST', headers,
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: { model: 'pos.payment.method', method: 'search_read', args: [[['journal_id', '=', finalJournalId]]], kwargs: { fields: ['id', 'name', 'journal_id'], limit: 1 } },
          }),
        });
        const pmData = await pmResp.json();
        finalPaymentMethodId = pmData?.result?.[0]?.id;
        if (!finalPaymentMethodId) {
          return { error: { message: 'No payment_method_id found for journalId ' + finalJournalId } };
        }
      }

      const paymentVals = {
        pos_order_id: orderId,
        amount: amt,
        payment_method_id: finalPaymentMethodId,
        partner_id: partnerId || false,
        session_id: sessionId || false,
        company_id: companyId || 1,
        client_uuid: lineUuid,
      };

      // client_uuid is an idempotency field that only exists where that patch is
      // applied; on a stock database it would reject the whole create. Prune the
      // optional keys, but never the three that make a payment meaningful.
      let safePaymentVals;
      try {
        safePaymentVals = await _pruneValsForModel(
          'pos.payment', paymentVals, baseUrl, headers, 'createPosPaymentOdoo',
          ['pos_order_id', 'amount', 'payment_method_id']);
      } catch (pruneErr) {
        _posLog(`payment ${pmtIdx + 1}/${paymentRecords.length}: ${pruneErr.message}`);
        results.push({ error: { message: pruneErr.message } });
        continue;
      }

      _posLog(`payment ${pmtIdx + 1}/${paymentRecords.length}: ${amt > 0 ? 'RECEIVED' : 'CHANGE'} amount=${amt} method=${finalPaymentMethodId} order=${orderId}`);

      const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call',
          params: { model: 'pos.payment', method: 'create', args: [safePaymentVals], kwargs: {} },
        }),
      });
      const data = await response.json();

      if (data && data.error) {
        const msg = data.error.data?.message || data.error.message || 'unknown error';
        _posLog(`payment ${pmtIdx + 1}/${paymentRecords.length} FAILED -> ${msg}`);
        results.push({ error: data.error });
      } else {
        _posLog(`payment ${pmtIdx + 1}/${paymentRecords.length} OK -> pos.payment id ${data.result}`);
        results.push({ result: data.result });
      }
    }
    return { results };
  } catch (error) {
    return { error };
  }
};

// Create a new POS session in Odoo
export const createPOSSesionOdoo = async ({ configId, userId }) => {
  try {
    if (!configId) throw new Error('configId is required');
    const { baseUrl, headers } = await _buildOdooHeaders();
    const vals = {
      config_id: configId,
      user_id: userId || false,
    };
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.session',
          method: 'create',
          args: [vals],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Close a POS session in Odoo
export const closePOSSesionOdoo = async ({ sessionId }) => {
  try {
    if (!sessionId) throw new Error('sessionId is required');
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.session',
          method: 'action_pos_session_closing_control',
          args: [[sessionId]],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Fetch restaurant tables from Odoo using JSON-RPC

export const fetchRestaurantTablesOdoo = async () => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'restaurant.table',
          method: 'search_read',
          args: [[]], // No filter, fetch all tables
          kwargs: { fields: [
            'id', 'table_number', 'display_name', 'floor_id', 'seats', 'shape',
            'position_h', 'position_v', 'width', 'height', 'color', 'active'
          ] }
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Fetch open POS orders for a given table id
export const fetchOpenOrdersByTable = async (tableId) => {
  try {
    if (!tableId) return { result: [] };
    // Exclude orders that are in final/closed states so only active/draft orders are returned
    // Include common closing states used across Odoo versions: done, cancel, paid, receipt, invoiced, posted
    const closedStates = ['done', 'cancel', 'paid', 'receipt', 'invoiced', 'posted'];
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'search_read',
          args: [[['table_id', '=', tableId], ['state', 'not in', closedStates]]],
          kwargs: { fields: ['id', 'name', 'state', 'amount_total', 'table_id', 'lines'] },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Create a draft pos.order assigned to a table
// preset_id defaults to undefined (not the old hardcoded 10); see createPosOrderOdoo.
export const createDraftPosOrderOdoo = async ({ sessionId, userId, tableId, partnerId = false, note = '', preset_id = undefined, order_type = null } = {}) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const vals = {
      session_id: sessionId,
      user_id: userId || false,
      partner_id: partnerId || false,
      table_id: tableId || false,
      lines: [],
      internal_note: note,
      amount_tax: 0,
      amount_total: 0,
      amount_paid: 0,
      amount_return: 0,
      state: 'draft',
    };
    if (preset_id !== undefined && preset_id !== null) vals.preset_id = preset_id;
    if (order_type) vals.order_type = String(order_type).toUpperCase();

    // table_id is the one that bit us: it only exists when pos_restaurant is
    // installed, and it was being sent unconditionally, so every takeaway order
    // failed with 'Invalid field table_id in pos.order' on databases without it.
    const safeVals = await _pruneValsForModel('pos.order', vals, baseUrl, headers, 'createDraftPosOrderOdoo', ['session_id']);

    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'create',
          args: [safeVals],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      return { error: data.error };
    }
    // data.result is the new record id
    const createdId = data.result;
    // Try to fetch the full created order record for logging (non-blocking for callers)
    try {
      const full = await fetchPosOrderById(createdId);
      if (full && full.result) {
      } else {
      }
    } catch (fetchErr) {
    }
    return { result: createdId };
  } catch (error) {
    return { error };
  }
};

// Update arbitrary fields on a pos.order record (e.g. customer_name, scheduled_date, scheduled_time)
export const updatePosOrderFields = async (orderId, fields = {}) => {
  try {
    if (!orderId || !fields || Object.keys(fields).length === 0) return { result: false };
    const { baseUrl, headers } = await _buildOdooHeaders();

    // Same guard as the create paths — this used to carry its own copy of the
    // fields_get + filter logic.
    const vals = await _pruneValsForModel('pos.order', fields, baseUrl, headers, 'updatePosOrderFields');
    console.log('[updatePosOrderFields] orderId:', orderId, 'writing:', JSON.stringify(vals));
    if (Object.keys(vals).length === 0) return { result: false };

    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: { model: 'pos.order', method: 'write', args: [[orderId], vals], kwargs: {} },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    console.log('[updatePosOrderFields] Odoo response:', JSON.stringify(data));
    if (data.error) return { error: data.error };
    return { result: data.result };
  } catch (error) {
    console.warn('[updatePosOrderFields] exception:', error);
    return { error };
  }
};
// Add a line to an existing pos.order using the correct 'lines' field
export const addLineToOrderOdoo = async ({ orderId, productId, qty = 1, price_unit = 0, name = '', taxes = [], note = '' } = {}) => {
  try {
    if (!orderId) throw new Error('orderId is required');
    if (!productId) throw new Error('productId is required');

    const qtyNum = Number(qty) || 1;
    const priceNum = Number(price_unit) || 0;
    const subtotal = qtyNum * priceNum;

    const lineVals = {
      product_id: productId,
      qty: qtyNum,
      price_unit: priceNum,
      name: name || '',
      price_subtotal: subtotal,
      price_subtotal_incl: subtotal,
    };
    if (note && String(note).trim()) {
      lineVals.customer_note = String(note).trim();
    }
    if (Array.isArray(taxes) && taxes.length > 0) {
      lineVals.tax_ids = taxes.map(t => typeof t === 'number' ? t : (t.id || t[0] || null)).filter(Boolean);
    }

    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'write',
          args: [[orderId], { lines: [[0, 0, lineVals]] }],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();

    if (data.error) {
      console.warn('[addLineToOrderOdoo] Odoo rejected line add for product', productId, '-', data.error?.data?.message || data.error?.message || data.error);
      return { error: data.error };
    }

    // After adding line, recalculate order totals
    await recomputePosOrderTotals(orderId);

    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Fetch all open POS orders (not done) optionally filtered by session or limit
export const fetchOpenOrders = async ({ sessionId = null, limit = 100 } = {}) => {
  try {
    const domain = [['state', '!=', 'done']];
    if (sessionId) domain.push(['session_id', '=', sessionId]);
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'search_read',
          args: [domain],
          kwargs: { fields: ['id', 'name', 'state', 'amount_total', 'table_id', 'create_date'], limit, order: 'create_date desc' },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();
    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Fetch orders without filtering out done orders (flexible fetch)
export const fetchOrders = async ({ sessionId = null, limit = 100, order = 'create_date desc', fields = null } = {}) => {
  try {
    const domain = [];
    if (sessionId) domain.push(['session_id', '=', sessionId]);
    const requested = Array.isArray(fields) && fields.length > 0 ? fields : ['id', 'name', 'state', 'amount_total', 'table_id', 'create_date'];

    const { baseUrl, headers } = await _buildOdooHeaders();
    const useFields = await _pruneFieldListForModel('pos.order', requested, baseUrl, headers, 'fetchOrders');
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'search_read',
          args: [domain],
          kwargs: { fields: useFields, limit, order },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();

    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Fetch a single pos.order by id (includes `lines` which are line ids)
export const fetchPosOrderById = async (orderId) => {
  try {
    if (!orderId) return { result: null };
    const { baseUrl, headers } = await _buildOdooHeaders();
    // include preset_id so clients can read the selected preset on the order
    const orderFields = await _pruneFieldListForModel('pos.order',
      ['id','name','state','amount_total','table_id','lines','create_date','user_id','partner_id','preset_id','pricelist_id','pos_reference'],
      baseUrl, headers, 'fetchPosOrderById');
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'search_read',
          args: [[['id', '=', orderId]]],
          kwargs: { fields: orderFields },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();

    if (data.error) {
      return { error: data.error };
    }
    const result = (data.result && data.result[0]) || null;
    return { result };
  } catch (error) {
    return { error };
  }
};

// Fetch pos.order.line records for given line ids
export const fetchOrderLinesByIds = async (lineIds = []) => {
  try {
    if (!Array.isArray(lineIds) || lineIds.length === 0) return { result: [] };
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order.line',
          method: 'search_read',
          args: [[['id', 'in', lineIds]]],
          kwargs: { fields: ['id','product_id','qty','price_unit','price_subtotal','price_subtotal_incl','tax_ids','discount','name','full_product_name','customer_note'] },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();

    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result || [] };
  } catch (error) {
    return { error };
  }
};

// Fetch pos.preset records (POS presets like Dine In / Takeaway)
//
// Only id + name are requested, deliberately. Odoo rejects a whole search_read
// when ANY requested field is invalid, so a field that exists in one Odoo
// version and not the next takes the entire preset list down with it — the
// Odoo 19 upgrade dropped 'available_in_self' and broke Takeaway Orders that
// way. id and name exist on every model in every version, and they are the only
// fields any caller reads. Do not add speculative fields here.
export const fetchPosPresets = async ({ limit = 200 } = {}) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.preset',
          method: 'search_read',
          args: [[]],
          kwargs: { fields: ['id','name'], limit, order: 'id asc' },
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();

    if (data.error) {
      return { error: data.error };
    }
    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Resolve the takeaway pos.preset id for THIS database.
//
// preset ids are per-database and are renumbered by Odoo upgrades/migrations.
// The app used to hardcode 10, which silently became a different preset after
// the server moved to Odoo 19 — paid orders were then written with the wrong
// preset and dropped out of the Takeaway Orders list. Match on name instead,
// the same rule TakeawayOrdersScreen uses to decide what belongs in that list.
//
// Returns null when nothing matches, so callers can omit preset_id rather than
// write a wrong one.
//
// Only a DEFINITIVE answer is cached. A failed RPC is not an answer about this
// database, and caching it used to strip preset_id from every order for the
// rest of the app session — one dropped request at startup was enough, since
// clearTakeawayPresetCache has no callers. Failures now fall through uncached
// so the next caller retries.
let _takeawayPresetId;
export const resolveTakeawayPresetId = async () => {
  if (_takeawayPresetId !== undefined) return _takeawayPresetId;
  try {
    const resp = await fetchPosPresets({ limit: 200 });
    if (resp && resp.error) {
      _posLog(`takeaway preset: lookup failed -> ${resp.error.data?.message || resp.error.message} (not cached, will retry)`);
      return null;
    }
    const presets = (resp && resp.result) || [];
    if (!Array.isArray(presets) || presets.length === 0) {
      _posLog('takeaway preset: none returned (empty list, not cached, will retry)');
      return null;
    }
    const take = presets.find((p) => String(p.name || '').toLowerCase().includes('take'));
    if (!take) {
      // A real answer about this database: presets exist, none is a takeaway.
      _posLog(`takeaway preset: no name contains "take" — presets are: ${presets.map((p) => p.name).join(', ')}`);
      return (_takeawayPresetId = null);
    }
    _posLog(`takeaway preset: "${take.name}" = id ${take.id}`);
    return (_takeawayPresetId = take.id);
  } catch (e) {
    _posLog(`takeaway preset: lookup threw -> ${e?.message || e} (not cached, will retry)`);
    return null;
  }
};

// Drop the cached preset id (call when the device is repointed at another DB).
export const clearTakeawayPresetCache = () => {
  _takeawayPresetId = undefined;
};

// Fetch schedule records for a POS preset (e.g. Takeout time slots by day)
export const fetchPresetSchedule = async (presetId) => {
  try {
    const { baseUrl, headers } = await _buildOdooHeaders();

    // Read the preset to get attendance_ids (schedule records)
    const presetResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: { model: 'pos.preset', method: 'read', args: [[presetId]], kwargs: { fields: ['attendance_ids'] } },
        id: new Date().getTime(),
      }),
    });
    const presetData = await presetResp.json();
    const attendanceIds = presetData?.result?.[0]?.attendance_ids;
    if (!Array.isArray(attendanceIds) || attendanceIds.length === 0) return { result: [] };

    // Fetch the attendance records from resource.calendar.attendance
    const schedResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: {
          model: 'resource.calendar.attendance',
          method: 'search_read',
          args: [[['id', 'in', attendanceIds]]],
          kwargs: { fields: ['id', 'name', 'dayofweek', 'day_period', 'hour_from', 'hour_to'] },
        },
        id: new Date().getTime(),
      }),
    });
    const schedData = await schedResp.json();
    if (schedData.error) return { result: [] };

    // Normalize: resource.calendar.attendance uses 'dayofweek' as string index ('0'=Mon, '1'=Tue, ...)
    const dayMap = { '0': 'monday', '1': 'tuesday', '2': 'wednesday', '3': 'thursday', '4': 'friday', '5': 'saturday', '6': 'sunday' };
    const normalized = (schedData.result || []).map(r => ({
      ...r,
      day_of_week: dayMap[String(r.dayofweek)] || String(r.dayofweek || '').toLowerCase(),
    }));

    console.log('[fetchPresetSchedule] loaded', normalized.length, 'records, sample:', JSON.stringify(normalized[0]));
    return { result: normalized };
  } catch (error) {
    console.warn('[fetchPresetSchedule] error:', error);
    return { result: [] };
  }
};

// Force recalculation of pos.order totals after line changes
export const recomputePosOrderTotals = async (orderId) => {
  try {
    if (!orderId) throw new Error('orderId is required');
    const { baseUrl, headers } = await _buildOdooHeaders();

    // Fetch all order lines to calculate totals
    const orderResponse = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'search_read',
          args: [[['id', '=', orderId]]],
          kwargs: { fields: ['id', 'lines'] },
        },
        id: new Date().getTime(),
      }),
    });
    const orderData = await orderResponse.json();

    if (orderData.error) {
      return { error: orderData.error };
    }

    const order = orderData.result?.[0];
    if (!order || !order.lines || order.lines.length === 0) {
      // Update order with 0 total
      await fetch(`${baseUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'pos.order',
            method: 'write',
            args: [[orderId], { amount_total: 0, amount_tax: 0, amount_paid: 0 }],
            kwargs: {},
          },
          id: new Date().getTime(),
        }),
      });
      return { result: true };
    }

    // Fetch all line details
    const linesResponse = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order.line',
          method: 'search_read',
          args: [[['id', 'in', order.lines]]],
          kwargs: { fields: ['id', 'qty', 'price_unit', 'price_subtotal', 'price_subtotal_incl', 'discount'] },
        },
        id: new Date().getTime(),
      }),
    });
    const linesData = await linesResponse.json();

    if (linesData.error) {
      return { error: linesData.error };
    }

    const lines = linesData.result || [];
    let totalAmount = 0;
    let totalTax = 0;

    // Calculate totals from lines
    lines.forEach(line => {
      const qty = Number(line.qty) || 0;
      const priceUnit = Number(line.price_unit) || 0;
      const discount = Number(line.discount) || 0;

      // Calculate line subtotal with discount
      let lineSubtotal = qty * priceUnit;
      if (discount > 0) {
        lineSubtotal = lineSubtotal * (1 - discount / 100);
      }

      totalAmount += lineSubtotal;
      // For now, assume no separate tax (can be enhanced later)
      totalTax += 0;
    });

    // Update the order with calculated totals
    const updateResponse = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'write',
          args: [[orderId], {
            amount_total: totalAmount,
            amount_tax: totalTax,
            amount_paid: totalAmount  // Set amount_paid equal to amount_total for now
          }],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const updateData = await updateResponse.json();

    if (updateData.error) {
      return { error: updateData.error };
    }

    return { result: true };
  } catch (error) {
    return { error };
  }
};

// Update an existing pos.order.line (qty, price_unit, name, etc.)
export const updateOrderLineOdoo = async ({ lineId, qty, price_unit, name, discount, note, orderId = null } = {}) => {
  try {
    if (!lineId) throw new Error('lineId is required');
    const vals = {};
    if (typeof qty !== 'undefined') vals.qty = Number(qty);
    if (typeof price_unit !== 'undefined') {
      vals.price_unit = Number(price_unit);
      // Recalculate subtotals when price_unit changes
      const effectiveQty = typeof qty !== 'undefined' ? Number(qty) : 1;
      const effectiveDiscount = typeof discount !== 'undefined' ? Number(discount) : 0;
      const discountedPrice = Number(price_unit) * (1 - effectiveDiscount / 100);
      vals.price_subtotal = effectiveQty * discountedPrice;
      vals.price_subtotal_incl = effectiveQty * discountedPrice;
    }
    if (typeof name !== 'undefined') vals.name = name;
    if (typeof discount !== 'undefined') vals.discount = Number(discount);
    if (typeof note !== 'undefined') {
      // customer_note = plain text shown in Odoo's "Add a Note" textarea popup
      vals.customer_note = note || '';
      // note = JSON array for getInternalNotes() / TagsList display
      if (note && String(note).trim()) {
        vals.note = JSON.stringify([{ text: String(note) }]);
      } else {
        vals.note = '[]';
        vals.customer_note = '';
      }
    }

    const { baseUrl, headers } = await _buildOdooHeaders();

    const doWrite = async (writeVals) => {
      const resp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'pos.order.line',
            method: 'write',
            args: [[lineId], writeVals],
            kwargs: {},
          },
          id: new Date().getTime(),
        }),
      });
      return await resp.json();
    };

    let data = await doWrite(vals);

    // If write fails (field doesn't exist), retry without note fields
    if (data.error && (vals.customer_note || vals.note)) {
      const retryVals = { ...vals };
      delete retryVals.customer_note;
      delete retryVals.note;
      data = await doWrite(retryVals);
    }

    if (data.error) {
      return { error: data.error };
    }

    // After updating line, recalculate order totals if orderId provided
    if (orderId) {
      await recomputePosOrderTotals(orderId);
    }

    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Remove (unlink) a pos.order.line by id
export const removeOrderLineOdoo = async ({ lineId, orderId = null } = {}) => {
  try {
    if (!lineId) throw new Error('lineId is required');
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order.line',
          method: 'unlink',
          args: [[lineId]],
          kwargs: {},
        },
        id: new Date().getTime(),
      }),
    });
    const data = await response.json();

    if (data.error) {
      return { error: data.error };
    }

    // After removing line, recalculate order totals if orderId provided
    if (orderId) {
      await recomputePosOrderTotals(orderId);
    }

    return { result: data.result };
  } catch (error) {
    return { error };
  }
};

// Fetch selection values for a given model field (e.g., pos.order state selection)
export const fetchFieldSelectionOdoo = async ({ model = '', field = '' } = {}) => {
  try {
    if (!model || !field) throw new Error('model and field are required');
    const { baseUrl, headers } = await _buildOdooHeaders();
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model,
          method: 'fields_get',
          args: [[field]],
          kwargs: { attributes: ['selection'] },
        },
      }),
    });
    const data = await response.json();

    if (data.error) {
      return [];
    }

    const fieldDef = data && data.result && data.result[field];
    if (!fieldDef) return [];
    return fieldDef.selection || [];
  } catch (error) {
    return [];
  }
};

// Post an invoice to assign an official number
export const postInvoiceOdoo = async (invoiceId) => {
  try {
    if (!invoiceId) throw new Error('invoiceId is required');
    const { baseUrl, headers } = await _buildOdooHeaders();
    const resp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'account.move',
          method: 'action_post',
          args: [[invoiceId]],
          kwargs: {},
        },
      }),
    });
    const respData = await resp.json();

    if (respData.error) {
      return { error: respData.error };
    }
    // fetch posted invoice to get number/name
    const info = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'account.move',
          method: 'search_read',
          args: [[['id', '=', invoiceId]]],
          kwargs: { fields: ['id', 'name', 'state', 'payment_state', 'amount_total', 'amount_residual'] },
        },
      }),
    });
    const infoData = await info.json();
    const meta = (infoData && infoData.result && infoData.result[0]) || null;
    return { result: meta };
  } catch (error) {
    return { error };
  }
};