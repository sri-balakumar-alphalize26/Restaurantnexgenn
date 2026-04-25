// In-memory product cache: fetch all products once, filter instantly for each category
let _allProductsCache = null;
let _allProductsCacheTime = 0;
let _allProductsCacheDb = null; // tracks which DB the cache belongs to
const PRODUCT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
          args: [[]],
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
    // Odoo 16+: only pos_categ_ids (Many2many) exists
    allProducts = await doFetch(['id', 'name', 'pos_categ_ids', 'list_price', 'taxes_id', 'default_code']);
  } catch (e1) {
    try {
      // Odoo 13-15: only pos_categ_id (Many2one) exists
      allProducts = await doFetch(['id', 'name', 'pos_categ_id', 'list_price', 'taxes_id', 'default_code']);
    } catch (e2) {
      // Neither field exists — get products without category info
      allProducts = await doFetch(['id', 'name', 'list_price', 'taxes_id', 'default_code']);
    }
  }

  const _preloadTs = Date.now();
  _allProductsCache = allProducts.map(p => {
    // Always lazy-load images via Odoo's binary endpoint — keeps the bulk
    // payload small. FlashList will fetch each image when its card renders.
    const imageUrl = `${baseUrl}/web/image?model=product.template&id=${p.id}&field=image_128&_ts=${_preloadTs}`;
    return { ...p, product_name: p.name || '', image_url: imageUrl };
  });
  _allProductsCacheTime = Date.now();
  _allProductsCacheDb = `${baseUrl}::${dbName}`;
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
  const baseFields = ['id', 'name', 'list_price', 'default_code'];

  const _ts = Date.now();
  const toProduct = (p) => ({
    ...p,
    product_name: p.name || '',
    image_url: `${baseUrl}/web/image?model=product.template&id=${p.id}&field=image_128&_ts=${_ts}`,
  });

  const doDirectFetch = async (domain, fields) => {
    const response = await axios.post(
      `${baseUrl}/web/dataset/call_kw`,
      {
        jsonrpc: '2.0', method: 'call',
        params: {
          model: 'product.template', method: 'search_read',
          args: [domain],
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
    return await doDirectFetch(
      [['pos_categ_ids', 'in', [catId]]],
      [...baseFields, 'pos_categ_ids']
    );
  } catch (_) {}

  // Tier 2: Odoo 13-15 — server-side filter by pos_categ_id (Many2one)
  try {
    return await doDirectFetch(
      [['pos_categ_id', '=', catId]],
      [...baseFields, 'pos_categ_id']
    );
  } catch (_) {}

  // Tier 3: Fallback — load all products and filter client-side
  try {
    const cacheKey = `${baseUrl}::${dbName}`;
    const cacheStale = !_allProductsCache
      || (Date.now() - _allProductsCacheTime > PRODUCT_CACHE_TTL)
      || _allProductsCacheDb !== cacheKey;
    if (cacheStale) await preloadAllProducts();
    return _filterByPosCategory(_allProductsCache, catId);
  } catch (_) {
    return [];
  }
};
// Fetch all product categories from Odoo (product.category)
export const fetchProductCategoriesOdoo = async () => {
  try {
    const { DEFAULT_ODOO_DB, DEFAULT_ODOO_BASE_URL } = require('../config/odooConfig');
    const url = (DEFAULT_ODOO_BASE_URL || ODOO_BASE_URL || '').replace(/\/$/, '') + '/web/dataset/call_kw';
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
      { headers: { 'Content-Type': 'application/json', 'X-Odoo-Database': DEFAULT_ODOO_DB } }
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

  // Try with all fields (Odoo 16+)
  try {
    return await doFetch(['id', 'name', 'parent_id', 'sequence', 'pos_config_ids', 'has_image', 'image_128', 'image_512']);
  } catch (_) {}

  // Try without image_512 (Odoo 13-15)
  try {
    return await doFetch(['id', 'name', 'parent_id', 'sequence', 'pos_config_ids', 'image_128']);
  } catch (_) {}

  // Minimal fields — always safe
  try {
    return await doFetch(['id', 'name', 'parent_id', 'sequence']);
  } catch (error) {
    throw error;
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
          args: [textDomain],
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
    // Odoo 16+: pos_categ_ids only
    products = await doDirectFetch(["id", "name", "list_price", "default_code", "uom_id", "image_128", "pos_categ_ids"]);
  } catch (e1) {
    try {
      // Odoo 13-15: pos_categ_id only
      products = await doDirectFetch(["id", "name", "list_price", "default_code", "uom_id", "image_128", "pos_categ_id"]);
    } catch (e2) {
      // Neither field — get products without category info
      products = await doDirectFetch(["id", "name", "list_price", "default_code", "uom_id", "image_128"]);
    }
  }

  // Apply client-side category filter if needed (cache was unavailable)
  if (catId) {
    products = _filterByPosCategory(products, catId);
  }

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

// Create POS order in Odoo via JSON-RPC
export const createPosOrderOdoo = async ({ partnerId = null, lines = [], sessionId = null, posConfigId = null, companyId = null, orderName = null, preset_id = 10, order_type = null, clientUuid = null } = {}) => {
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
        product_id: l.product_id || l.id,
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
    if (order_type) {
      try {
        const hasField = await (async (field) => {
          try {
            if (!global.__pos_order_fields_cache) {
              const fieldsResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
                method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model: 'pos.order', method: 'fields_get', args: [], kwargs: {} } }),
              });
              const fieldsData = await fieldsResp.json();
              global.__pos_order_fields_cache = fieldsData && fieldsData.result ? Object.keys(fieldsData.result) : [];
            }
            return Array.isArray(global.__pos_order_fields_cache) && global.__pos_order_fields_cache.includes(field);
          } catch (e) {
            return false;
          }
        })('order_type');
        if (hasField) vals.order_type = String(order_type).toUpperCase();
      } catch (e) {}
    }
    if (sessionId) vals.session_id = sessionId;
    if (posConfigId) vals.config_id = posConfigId;
    if (typeof preset_id !== 'undefined') vals.preset_id = preset_id;

    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
          method: 'create',
          args: [vals],
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
// Accepts either a single payment or an array of payments
export const createPosPaymentOdoo = async ({ orderId, payments, amount, journalId, paymentMethodId, paymentMode = 'cash', partnerId = null, sessionId = null, companyId = null } = {}) => {
  try {
    if (!orderId) throw new Error('orderId is required');

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
    for (const payment of paymentRecords) {
      const amt = Number(payment.amount) || 0;
      if (amt === 0) continue;

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
      };

      const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call',
          params: { model: 'pos.payment', method: 'create', args: [paymentVals], kwargs: {} },
        }),
      });
      const data = await response.json();

      if (data && data.error) {
        results.push({ error: data.error });
      } else {
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
export const createDraftPosOrderOdoo = async ({ sessionId, userId, tableId, partnerId = false, note = '', preset_id = 10, order_type = null } = {}) => {
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
      preset_id: preset_id,
    };
    if (order_type) {
      try {
        const hasField = await (async (field) => {
          try {
            if (!global.__pos_order_fields_cache) {
              const fieldsResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'call',
                  params: {
                    model: 'pos.order',
                    method: 'fields_get',
                    args: [],
                    kwargs: {},
                  },
                }),
              });
              const fieldsData = await fieldsResp.json();
              global.__pos_order_fields_cache = fieldsData && fieldsData.result ? Object.keys(fieldsData.result) : [];
            }
            return Array.isArray(global.__pos_order_fields_cache) && global.__pos_order_fields_cache.includes(field);
          } catch (e) {
            return false;
          }
        })('order_type');
        if (hasField) vals.order_type = String(order_type).toUpperCase();
      } catch (e) {
        // ignore
      }
    }
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'pos.order',
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

    // Ensure we have the fields cache so we only write fields that exist on the model
    if (!global.__pos_order_fields_cache) {
      try {
        const fieldsResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: { model: 'pos.order', method: 'fields_get', args: [], kwargs: {} },
          }),
        });
        const fieldsData = await fieldsResp.json();
        global.__pos_order_fields_cache = fieldsData && fieldsData.result ? Object.keys(fieldsData.result) : [];
      } catch (_) {}
    }

    const validFields = Array.isArray(global.__pos_order_fields_cache) ? global.__pos_order_fields_cache : [];
    const vals = {};
    const skipped = [];
    for (const [key, value] of Object.entries(fields)) {
      if (validFields.length === 0 || validFields.includes(key)) {
        vals[key] = value;
      } else {
        skipped.push(key);
      }
    }
    console.log('[updatePosOrderFields] orderId:', orderId, 'writing:', JSON.stringify(vals), 'skipped:', skipped);
    // Log datetime-related fields available on model for debugging
    if (validFields.length > 0) {
      const dateFields = validFields.filter(f => f.includes('date') || f.includes('time') || f.includes('schedule') || f.includes('pickup') || f.includes('preset') || f.includes('planned'));
      console.log('[updatePosOrderFields] date/time fields on pos.order:', dateFields);
    }
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
    const useFields = Array.isArray(fields) && fields.length > 0 ? fields : ['id', 'name', 'state', 'amount_total', 'table_id', 'create_date'];

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
          // include preset_id so clients can read the selected preset on the order
          kwargs: { fields: ['id','name','state','amount_total','table_id','lines','create_date','user_id','partner_id','preset_id','pricelist_id','pos_reference'] },
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
          kwargs: { fields: ['id','name','available_in_self','use_guest','pricelist_id','color','image_128'], limit, order: 'id asc' },
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