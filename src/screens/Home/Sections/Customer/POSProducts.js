import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, ScrollView, Modal, Pressable, StyleSheet as RNStyleSheet, InteractionManager, Platform, Alert, ActivityIndicator } from 'react-native';
import { NavigationHeader } from '@components/Header';
import { ProductsList } from '@components/Product';
import { fetchPosPresets, addLineToOrderOdoo, updateOrderLineOdoo, removeOrderLineOdoo, fetchPosOrderById, fetchOrderLinesByIds, fetchPosCategoriesOdoo, fetchProductCategoriesOdoo, fetchCategoriesOdoo, preloadAllProducts, createDraftPosOrderOdoo, fetchPosPaymentMethodsOdoo, createPosOrderOdoo, createPosPaymentOdoo, fetchPOSSessions, fetchPricelistsOdoo, fetchPricelistItemsOdoo, updatePosOrderFields, fetchPresetSchedule } from '@api/services/generalApi';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { FlashList } from '@shopify/flash-list';
import { formatData } from '@utils/formatters';
import { formatCurrency } from '@utils/formatters/currency';
import { OverlayLoader } from '@components/Loader';
import { SafeAreaView } from '@components/containers';
import { COLORS } from '@constants/theme';
import styles from './styles';
import { EmptyState } from '@components/common/empty';
import { useProductStore } from '@stores/product';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AntDesign } from '@expo/vector-icons';
import { Button } from '@components/common/Button';
import useKitchenTickets from '@stores/kitchen/ticketsStore';
import { useTranslation, usePressOnce } from '@hooks';
import { loadPosConfig } from '@api/services/kotService';

// Helper: build Odoo headers from AsyncStorage (same as generalApi._buildOdooHeaders)
const _buildOdooHeadersLocal = async () => {
  const { DEFAULT_ODOO_DB, DEFAULT_ODOO_BASE_URL } = require('@api/config/odooConfig');
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

// Static styles — created once, never re-allocated
const localStyles = RNStyleSheet.create({
  qtyBtn: {
    backgroundColor: '#f0f0f0',
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  qtyText: { fontSize: 24, fontWeight: '700', color: '#111' },
  qtyDisplay: { minWidth: 32, textAlign: 'center', fontWeight: '700', fontSize: 18, marginHorizontal: 8 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  modalCard: { width: '88%', backgroundColor: '#fff', borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 16, fontWeight: '800', marginBottom: 8 },
  modalSubtitle: { fontSize: 14, marginBottom: 12, color: '#374151' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qtyLabel: { fontSize: 16, fontWeight: '700' },
  qtyButtons: { flexDirection: 'row', alignItems: 'center' },
  divider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 12 },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  cancelBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#f3f4f6', marginRight: 10 },
  cancelText: { fontWeight: '700' },
  addBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#111827' },
  addBtnText: { color: '#fff', fontWeight: '800' },
  confirmOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', zIndex: 9999 },
  confirmChip: { backgroundColor: '#111827', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20 },
  confirmTitle: { fontSize: 15, fontWeight: '800', color: '#fff', textAlign: 'center' },
  confirmSub: { fontSize: 13, color: '#d1d5db', textAlign: 'center', marginTop: 4 },
  // Products modal header
  productsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#2E294E',
  },
  productsBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  productsHeaderTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 0.3,
  },
  productsSearchWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: '#2E294E',
  },
  productsSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 12 : 2,
    minHeight: 46,
  },
  productsSearchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#1a1a2e',
    padding: 0,
    margin: 0,
  },
  catPill: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  catText: { fontWeight: '700', fontSize: 13 },
  catBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  catScroll: { paddingVertical: 6 },
  productsList: { padding: 10, paddingBottom: 80 },

  // Floating "Go to Register" button
  floatingRegisterBtn: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2E294E',
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 28,
    ...Platform.select({
      ios: { shadowColor: '#2E294E', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 8 },
    }),
  },
  floatingRegisterText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.3,
  },

  // Register panel — modern card
  registerPanel: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    marginTop: 8,
    ...Platform.select({
      ios: { shadowColor: '#1a1a2e', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 4 },
    }),
  },
  registerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f8',
  },
  registerTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#1a1a2e',
    letterSpacing: 0.3,
  },
  registerOrderName: {
    fontSize: 12,
    color: '#8896ab',
    fontWeight: '600',
    marginTop: 2,
  },
  registerUserBadge: {
    backgroundColor: '#f0f2f8',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
  },
  registerUserText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7a90',
  },

  // Column header
  columnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    backgroundColor: '#f8f9fc',
    borderRadius: 10,
    marginBottom: 6,
  },
  colHeaderText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8896ab',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  colDivider: {
    width: 1,
    backgroundColor: '#d0d5dd',
    alignSelf: 'stretch',
    marginHorizontal: 4,
  },
  rowDivider: {
    width: 1,
    backgroundColor: '#e0e3e8',
    alignSelf: 'stretch',
    marginHorizontal: 4,
  },

  // Order line
  orderLineRow: {
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderColor: '#f0f2f8',
    flexDirection: 'row',
    alignItems: 'center',
  },
  orderLineSno: {
    fontWeight: '700',
    fontSize: 13,
    color: '#8896ab',
    width: 24,
    textAlign: 'center',
  },
  orderLineName: {
    fontWeight: '700',
    fontSize: 13,
    color: '#1a1a2e',
  },
  orderLinePrice: {
    color: '#8896ab',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  orderLineControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 130,
  },
  orderLineBtn: {
    backgroundColor: '#f0f2f8',
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderLineBtnText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1a1a2e',
  },
  orderLineQty: {
    minWidth: 30,
    textAlign: 'center',
    fontWeight: '800',
    fontSize: 14,
    color: '#1a1a2e',
    marginHorizontal: 2,
  },
  orderLineTotal: {
    fontWeight: '800',
    fontSize: 13,
    color: '#1a1a2e',
    width: 80,
    textAlign: 'right',
  },

  // Total section
  totalSection: {
    marginTop: 12,
    paddingTop: 14,
    borderTopWidth: 2,
    borderTopColor: '#1a1a2e',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    fontSize: 15,
    color: '#8896ab',
    fontWeight: '700',
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  breakdownLabel: {
    fontSize: 13,
    color: '#8896ab',
    fontWeight: '600',
  },
  breakdownValue: {
    fontSize: 13,
    color: '#1a1a2e',
    fontWeight: '700',
  },
  totalValue: {
    fontSize: 26,
    fontWeight: '900',
    color: '#1a1a2e',
    letterSpacing: 0.5,
  },

  // Bottom actions — SafeAreaView wrapper applies the device-specific
  // bottom inset, so we just need a small visual margin here.
  bottomActions: {
    marginTop: 14,
    marginBottom: 12,
    gap: 10,
  },
  kitchenBillBtn: {
    backgroundColor: '#7c3aed',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#7c3aed', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 6 },
    }),
  },
  kitchenBillBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 0.3,
  },

  presetSheet: { backgroundColor: '#fff', padding: 12, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  presetTitle: { fontSize: 16, fontWeight: '800', marginBottom: 8 },
  presetItem: { padding: 12, borderRadius: 8, marginBottom: 8 },
  presetText: { fontSize: 15, fontWeight: '700' },
  presetCancel: { padding: 12, marginTop: 6, borderRadius: 8, backgroundColor: '#f3f4f6' },
  presetCancelText: { textAlign: 'center', fontWeight: '700' },
  addProductsBtn: { paddingVertical: 8 },

  // Payment button on register panel
  payNowBtn: {
    backgroundColor: '#16a34a',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 8,
    ...Platform.select({
      ios: { shadowColor: '#16a34a', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 6 },
    }),
  },
  payNowBtnText: { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 0.3 },

  // PIN gate modal
  pinOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  pinCard: { backgroundColor: '#fff', borderRadius: 16, padding: 22, width: '100%', maxWidth: 380 },
  pinHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  pinTitle: { fontSize: 16, fontWeight: '800', color: '#2E294E' },
  pinClose: { fontSize: 20, color: '#888', padding: 4 },
  pinHint: { fontSize: 13, color: '#555', marginBottom: 14 },
  pinInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, fontSize: 16, color: '#2E294E', marginBottom: 8 },
  pinErrText: { color: '#e53935', fontSize: 12, marginBottom: 8 },
  pinSubmitBtn: { backgroundColor: '#2E294E', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 6 },
  pinSubmitText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Payment modal
  payModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  payModalCard: { backgroundColor: '#fff', borderRadius: 24, padding: 24, paddingBottom: 28, width: '100%', maxWidth: 500 },
  payModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  payModalTitle: { fontSize: 20, fontWeight: '900', color: '#1a1a2e' },
  payModalClose: { fontSize: 22, fontWeight: '700', color: '#8896ab', padding: 4 },
  payTotalBox: { backgroundColor: '#f8f9fc', borderRadius: 16, padding: 18, alignItems: 'center', marginBottom: 20 },
  payTotalLabel: { fontSize: 13, fontWeight: '600', color: '#8896ab', marginBottom: 4 },
  payTotalValue: { fontSize: 32, fontWeight: '900', color: '#1a1a2e' },
  payMethodRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f6f8fa', borderRadius: 14, paddingVertical: 16, paddingHorizontal: 16, marginBottom: 8, borderWidth: 2, borderColor: '#eee' },
  payMethodRowActive: { backgroundColor: '#2E294E', borderColor: '#2E294E' },
  payModeIcon: { fontSize: 24, marginRight: 14 },
  payMethodName: { fontSize: 16, fontWeight: '700', color: '#1a1a2e', flex: 1 },
  payMethodNameActive: { color: '#fff' },
  payMethodCheck: { fontSize: 18, fontWeight: '800', color: '#22c55e' },
  payAmountLabel: { fontSize: 14, fontWeight: '700', color: '#444', marginBottom: 8 },
  payAmountInput: { borderWidth: 1.5, borderColor: '#e0e0e0', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, fontSize: 22, fontWeight: '700', color: '#1a1a2e', textAlign: 'center', backgroundColor: '#f8f9fc' },
  payChangeText: { color: '#16a34a', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  payRemainingText: { color: '#dc2626', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  payConfirmBtn: { backgroundColor: '#16a34a', paddingVertical: 18, borderRadius: 14, alignItems: 'center', justifyContent: 'center', ...Platform.select({ ios: { shadowColor: '#16a34a', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }, android: { elevation: 6 } }) },
  payConfirmText: { color: '#fff', fontWeight: '900', fontSize: 18, letterSpacing: 0.3 },

  // Discount info on order line
  discountInfoRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 },
  discountBadge: { backgroundColor: '#dc2626', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  discountBadgeText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  discountOrigPrice: { fontSize: 12, color: '#aaa', textDecorationLine: 'line-through', fontWeight: '500' },
  discountArrow: { fontSize: 12, color: '#aaa' },
  discountNewPrice: { fontSize: 13, color: '#16a34a', fontWeight: '800' },

  // Discount modal
  orderLineNote: { fontSize: 11, color: '#7c3aed', fontWeight: '600', marginTop: 3, fontStyle: 'italic' },

  // Note section in popup
  noteSection: { marginBottom: 16 },
  noteSectionTitle: { fontSize: 14, fontWeight: '800', color: '#1a1a2e', marginBottom: 8 },
  noteInput: { backgroundColor: '#f8f9fc', borderRadius: 12, borderWidth: 1, borderColor: '#e5e7eb', padding: 12, fontSize: 14, color: '#1a1a2e', minHeight: 70, fontWeight: '500' },
  discountSectionTitle: { fontSize: 14, fontWeight: '800', color: '#1a1a2e', marginBottom: 10 },

  discountOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  discountCard: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400 },
  discountHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  discountTitle: { fontSize: 20, fontWeight: '900', color: '#1a1a2e' },
  discountCloseBtn: { fontSize: 22, fontWeight: '700', color: '#8896ab', padding: 4 },
  discountProductName: { fontSize: 14, fontWeight: '600', color: '#6b7a90', marginBottom: 20, textAlign: 'center' },
  discountGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center', marginBottom: 20 },
  discountOption: { width: '28%', backgroundColor: '#f6f8fa', borderRadius: 14, paddingVertical: 20, alignItems: 'center', borderWidth: 2, borderColor: '#eee' },
  discountOptionActive: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  discountOptionText: { fontSize: 22, fontWeight: '900', color: '#1a1a2e' },
  discountOptionTextActive: { color: '#fff' },
  discountRemoveBtn: { backgroundColor: '#fef2f2', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#fecaca' },
  discountRemoveBtnText: { color: '#dc2626', fontWeight: '800', fontSize: 15 },
  discountCancelBtn: { backgroundColor: '#f3f4f6', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  discountCancelText: { fontWeight: '700', fontSize: 15, color: '#444' },

  // Pricelist toggle buttons
  pricelistRow: { flexDirection: 'row', gap: 8, marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#f0f2f8' },
  pricelistBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: '#f0f2f8', borderWidth: 1.5, borderColor: '#e0e3e8' },
  pricelistBtnNormal: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  pricelistBtnTalabat: { backgroundColor: '#e11d48', borderColor: '#e11d48' },
  pricelistBtnText: { fontSize: 12, fontWeight: '800', color: '#6b7a90', letterSpacing: 0.5 },
  pricelistBtnTextActive: { color: '#fff' },
});

const POSProducts = ({ navigation, route }) => {
  const { t } = useTranslation();
  const {
    openingAmount, sessionId, registerId, registerName, userId, userName
  } = route?.params || {};

  // POS category state
  const [posCategories, setPosCategories] = useState([]);
  const [productCategories, setProductCategories] = useState([]);
  const [selectedPosCategoryId, setSelectedPosCategoryId] = useState(null);
  const [posFilteredProducts, setPosFilteredProducts] = useState(null);

  // Store
  const { addProduct, setCurrentCustomer, clearProducts, removeProduct, loadCustomerCart } = useProductStore();
  const [loadedOrderLines, setLoadedOrderLines] = useState([]);
  const [presets, setPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showProducts, setShowProducts] = useState(false);

  // Quick Add state
  const [quickAddVisible, setQuickAddVisible] = useState(false);
  const [quickProduct, setQuickProduct] = useState(null);
  const [quickQty, setQuickQty] = useState(1);
  const [quickNote, setQuickNote] = useState('');
  const [orderInfo, setOrderInfo] = useState(route?.params?.orderState ? { state: route.params.orderState } : null);
  const isOrderClosed = ['paid', 'done', 'cancel', 'invoiced', 'posted'].includes(String(orderInfo?.state || ''));
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [confirmQty, setConfirmQty] = useState(1);
  const [backLoading, setBackLoading] = useState(false);

  // ── KOT wizard (order name + time slot) ──────────────────────
  const [kotWizardStep, setKotWizardStep] = useState(null); // null | 'name' | 'time'
  const [kotCustomerName, setKotCustomerName] = useState('');
  const [kotRecentNames, setKotRecentNames] = useState([]);
  const [kotSelectedDate, setKotSelectedDate] = useState(null);
  const [kotSelectedTime, setKotSelectedTime] = useState(null);
  const kotPendingParamsRef = useRef(null);
  const [kotSchedule, setKotSchedule] = useState(null);

  // Payment state
  const [payModalVisible, setPayModalVisible] = useState(false);
  const [selectedPayMethodId, setSelectedPayMethodId] = useState(null);
  const [payInputAmount, setPayInputAmount] = useState('');
  const [paying, setPaying] = useState(false);
  const [payMethods, setPayMethods] = useState([]);
  // PIN gate for Pay Now — unlocks after correct PIN, stays unlocked for the session.
  // PIN source of truth is Odoo pos.config.payment_pin (set per-POS by the admin).
  // Empty/missing payment_pin in Odoo => gate is disabled (no PIN required).
  const [payUnlocked, setPayUnlocked] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);
  const [expectedPin, setExpectedPin] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const storedId = await AsyncStorage.getItem('pos_config_id');
        // Force a fresh re-fetch so a PIN set in Odoo after login is picked up
        // without the user having to log out and back in.
        const cfg = await loadPosConfig(storedId ? Number(storedId) : null);
        const pin = String(cfg?.payment_pin || '').trim();
        setExpectedPin(pin);
        if (!pin) setPayUnlocked(true); // No PIN configured in Odoo — skip the gate.
      } catch (_) {}
    })();
  }, []);

  // Discount state
  const [discountModalVisible, setDiscountModalVisible] = useState(false);
  const [discountTargetItem, setDiscountTargetItem] = useState(null);
  const DISCOUNT_OPTIONS = [10, 20, 30, 40, 50];

  // Pricelist state
  const [pricelists, setPricelists] = useState([]);
  const [activePricelistId, setActivePricelistId] = useState(null);
  const activePricelistRef = useRef(null);
  const [pricelistItems, setPricelistItems] = useState({});
  const pricelistItemsRef = useRef({});
  const [taxRateMap, setTaxRateMap] = useState({}); // { taxId: amount (percent) }
  const [noteText, setNoteText] = useState('');
  const pendingSyncs = useRef([]);  // Track pending addLine API calls
  const initialLoadDone = useRef(false);  // Track if initial server load is complete
  const orderIdRef = useRef(route?.params?.orderId || null);  // Mutable orderId — set lazily for takeaway
  // Idempotency key for the current Pay Now attempt — survives across retries
  // so a double-tap or auto-retry never creates duplicate pos.payment rows.
  // Cleared only on confirmed success.
  const paymentUuidRef = useRef(null);

  // Search: input value updates instantly, filter value is debounced so it doesn't block touches
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimer = useRef(null);
  const handleSearchChange = useCallback((text) => {
    setSearchText(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(text), 300);
  }, []);

  const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const _kotFormatDate = (d) => {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  };

  const _kotFormatDateLabel = (d) => {
    return `${WEEKDAY_SHORT[d.getDay()]} ${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  };

  const _generateSlots = (hourFrom, hourTo) => {
    const slots = [];
    const startMin = Math.round(hourFrom * 60);
    const endMin = Math.round(hourTo * 60);
    for (let m = startMin; m < endMin; m += 20) {
      slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    return slots;
  };

  const _periodLabel = (period) => {
    const p = String(period || '').toLowerCase();
    if (p === 'break' || p === 'lunch') return 'Lunch';
    if (p === 'afternoon') return 'Afternoon';
    if (p === 'morning') return 'Morning';
    if (p === 'evening') return 'Evening';
    return period || 'Other';
  };

  // Filter out past time slots for today
  const _filterPastSlots = (slots, selectedDate) => {
    const now = new Date();
    if (!selectedDate || selectedDate.toDateString() !== now.toDateString()) return slots;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    return slots.filter(s => {
      const [hh, mm] = s.split(':').map(Number);
      return hh * 60 + mm > currentMinutes;
    });
  };

  // Available dates — from schedule or fallback to next 7 days
  const kotAvailableDates = useMemo(() => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    return days;
  }, []);

  // Time groups — from schedule or fallback with past-time filtering
  const kotTimeGroups = useMemo(() => {
    // Fallback groups
    const fallbackSlots = [];
    for (let h = 7; h <= 22; h++) {
      for (let m = 0; m < 60; m += 20) {
        if (h === 22 && m > 0) break;
        fallbackSlots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      }
    }
    const fallbackGroup = (slot) => { const h = parseInt(slot.split(':')[0], 10); return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'; };
    const buildFallback = () => ['Morning', 'Afternoon', 'Evening'].map(g => ({
      label: g, slots: _filterPastSlots(fallbackSlots.filter(s => fallbackGroup(s) === g), kotSelectedDate),
    })).filter(g => g.slots.length > 0);

    if (!kotSchedule || !Array.isArray(kotSchedule) || kotSchedule.length === 0 || !kotSelectedDate) {
      return buildFallback();
    }

    const selectedDayName = WEEKDAY_NAMES[kotSelectedDate.getDay()];
    const dayRecords = kotSchedule.filter(s => String(s.day_of_week || '').toLowerCase() === selectedDayName);
    if (dayRecords.length === 0) return []; // No schedule for this day

    const groups = [];
    for (const rec of dayRecords) {
      const hourFrom = typeof rec.hour_from === 'number' ? rec.hour_from : null;
      const hourTo = typeof rec.hour_to === 'number' ? rec.hour_to : null;
      if (hourFrom === null || hourTo === null || hourFrom >= hourTo) continue;
      const slots = _filterPastSlots(_generateSlots(hourFrom, hourTo), kotSelectedDate);
      if (slots.length > 0) groups.push({ label: _periodLabel(rec.day_period), slots });
    }
    return groups;
  }, [kotSchedule, kotSelectedDate]);

  const _kotLoadRecentNames = async () => {
    try {
      const raw = await AsyncStorage.getItem('kot_recent_names');
      if (raw) setKotRecentNames(JSON.parse(raw));
    } catch (_) {}
  };

  const _kotSaveName = async (name) => {
    try {
      const trimmed = name.trim();
      if (!trimmed) return;
      const updated = [trimmed, ...kotRecentNames.filter(n => n !== trimmed)].slice(0, 6);
      setKotRecentNames(updated);
      await AsyncStorage.setItem('kot_recent_names', JSON.stringify(updated));
    } catch (_) {}
  };

  const openKotWizard = async (baseParams) => {
    kotPendingParamsRef.current = baseParams;
    setKotCustomerName('');
    setKotSelectedTime(null);
    setKotSelectedDate(null);

    // Dine-In orders skip order name & time slot wizard
    const isTakeaway = String(baseParams?.order_type || route?.params?.order_type || '').toUpperCase() === 'TAKEAWAY';
    if (!isTakeaway) {
      navigation.navigate('KitchenBillPreview', { ...baseParams });
      return;
    }

    // Fetch preset schedule from Odoo
    const presetId = route?.params?.preset_id || 10;
    try {
      const resp = await fetchPresetSchedule(presetId);
      console.log('[KOT Wizard] schedule fetch result:', JSON.stringify(resp?.result?.map(r => ({ name: r.name, day: r.day_of_week, period: r.day_period, from: r.hour_from, to: r.hour_to }))));
      if (resp?.result && Array.isArray(resp.result) && resp.result.length > 0) {
        setKotSchedule(resp.result);
      } else {
        setKotSchedule(null);
      }
    } catch (_) {
      setKotSchedule(null);
    }

    await _kotLoadRecentNames();
    setKotWizardStep('name');
  };

  // Auto-select first available date when wizard opens
  useEffect(() => {
    if (kotWizardStep && kotAvailableDates.length > 0 && !kotSelectedDate) {
      setKotSelectedDate(kotAvailableDates[0]);
    }
  }, [kotSchedule, kotWizardStep, kotAvailableDates, kotSelectedDate]);

  const onKotNameNext = () => setKotWizardStep('time');

  const onKotTimeConfirm = async () => {
    const name = kotCustomerName.trim();
    await _kotSaveName(name);
    setKotWizardStep(null);
    const p = kotPendingParamsRef.current || {};

    // Save customer name & time slot to Odoo immediately (before navigation)
    const oid = p.orderId || orderIdRef.current;
    if (oid) {
      const odooFields = {};
      if (name) odooFields.floating_order_name = name;
      if (kotSelectedDate) {
        const d = kotSelectedDate;
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const dateStr = `${d.getFullYear()}-${mm}-${dd}`;
        odooFields.shipping_date = dateStr;
        if (kotSelectedTime) {
          odooFields.preset_time = `${dateStr} ${kotSelectedTime}:00`;
        }
      }
      if (Object.keys(odooFields).length > 0) {
        console.log('[KOT Wizard] saving to Odoo orderId:', oid, 'fields:', JSON.stringify(odooFields));
        updatePosOrderFields(oid, odooFields).catch((e) => console.warn('[KOT Wizard] save failed:', e));
      }
    }

    navigation.navigate('KitchenBillPreview', {
      ...p,
      customerName: name || undefined,
      scheduledDate: kotSelectedDate ? _kotFormatDate(kotSelectedDate) : undefined,
      scheduledTime: kotSelectedTime || undefined,
    });
  };

  const setSnapshot = useKitchenTickets((s) => s.setSnapshot);

  // Load payment methods from Odoo (dynamic — fetches Cash, Talabat, Bank Transfer, Card, etc.)
  useEffect(() => {
    (async () => {
      try {
        const methods = await fetchPosPaymentMethodsOdoo();
        setPayMethods(methods);
        if (methods.length > 0) setSelectedPayMethodId(methods[0].id);
      } catch (_) {}
    })();
  }, []);

  // Load pricelists from Odoo
  useEffect(() => {
    (async () => {
      try {
        const lists = await fetchPricelistsOdoo();
        setPricelists(lists);

        // Check if order already has a pricelist set
        let orderPlId = null;
        const existingOrderId = orderIdRef.current;
        if (existingOrderId) {
          try {
            const orderResp = await fetchPosOrderById(existingOrderId);
            const plField = orderResp?.result?.pricelist_id;
            orderPlId = Array.isArray(plField) ? plField[0] : plField;
          } catch (_) {}
        }

        // Use order's pricelist if set, otherwise default to dine-in
        if (orderPlId && lists.some(p => p.id === orderPlId)) {
          setActivePricelistId(orderPlId);
          activePricelistRef.current = orderPlId;
        } else {
          const normal = lists.find(p => !p.name?.toLowerCase().includes('talabat') && !p.name?.toLowerCase().includes('application'));
          const defaultId = normal ? normal.id : (lists.length > 0 ? lists[0].id : null);
          if (defaultId) { setActivePricelistId(defaultId); activePricelistRef.current = defaultId; }
        }
        // Pre-fetch ALL pricelist items + ALL product template mappings for instant switching
        try {
          const { baseUrl, headers } = await _buildOdooHeadersLocal();
          // Fetch all pricelist items across all pricelists
          const allPlResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
            method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model: 'product.pricelist.item', method: 'search_read', args: [[]], kwargs: { fields: ['pricelist_id', 'product_tmpl_id', 'product_id', 'fixed_price'], limit: 5000 } } }),
          });
          const allPlData = await allPlResp.json();
          const allItems = allPlData?.result || [];
          // Build cache: { plId: { tmplId: fixedPrice } }
          const cache = {};
          allItems.forEach(item => {
            const plId = Array.isArray(item.pricelist_id) ? item.pricelist_id[0] : item.pricelist_id;
            const tid = Array.isArray(item.product_tmpl_id) ? item.product_tmpl_id[0] : item.product_tmpl_id;
            const fp = item.fixed_price;
            if (plId && tid && fp !== false && fp !== null && fp !== undefined) {
              if (!cache[plId]) cache[plId] = {};
              cache[plId][tid] = Number(fp);
            }
          });

          // Fetch all products to map product_id → tmpl_id + lst_price + taxes_id
          const allProdResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
            method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model: 'product.product', method: 'search_read', args: [[]], kwargs: { fields: ['id', 'product_tmpl_id', 'lst_price', 'list_price', 'taxes_id'], limit: 5000 } } }),
          });
          const allProdData = await allProdResp.json();
          const allProds = allProdData?.result || [];
          const prodMap = {};
          allProds.forEach(p => {
            prodMap[p.id] = {
              tmplId: Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id,
              lstPrice: p.lst_price || p.list_price || 0,
              taxesId: Array.isArray(p.taxes_id) ? p.taxes_id : [],
            };
          });

          const plData2 = { _cache: cache, _prodMap: prodMap };
          setPricelistItems(plData2);
          pricelistItemsRef.current = plData2;

          // Fetch all account.tax rates for per-product tax-inclusive display
          try {
            const taxResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
              method: 'POST', headers,
              body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model: 'account.tax', method: 'search_read', args: [[]], kwargs: { fields: ['id', 'amount', 'price_include'], limit: 500 } } }),
            });
            const taxData = await taxResp.json();
            const taxMap = {};
            (taxData?.result || []).forEach(t => {
              taxMap[t.id] = { amount: Number(t.amount) || 0, priceInclude: !!t.price_include };
            });
            setTaxRateMap(taxMap);
          } catch (_) {}
        } catch (_) {}
      } catch (_) {}
    })();
  }, []);

  // Switch pricelist — INSTANT using pre-cached data, then sync to Odoo in background
  const handleSwitchPricelist = useCallback((pricelistId) => {
    if (pricelistId === activePricelistRef.current) return;
    activePricelistRef.current = pricelistId;
    setActivePricelistId(pricelistId);

    const cartItems = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
    if (cartItems.length === 0) return;

    const cache = pricelistItems?._cache || {};
    const prodMap = pricelistItems?._prodMap || {};
    const plCache = cache[pricelistId] || {};

    // INSTANT: Update all cart items from cache — no API calls
    for (const cartItem of cartItems) {
      const pid = cartItem.remoteId || (typeof cartItem.id === 'number' ? cartItem.id : null);
      if (!pid) continue;

      const info = prodMap[pid];
      const tmplId = info?.tmplId;

      // Priority: pricelist price → lst_price fallback
      let rawPrice = (tmplId && plCache[tmplId] !== undefined) ? plCache[tmplId] : (info?.lstPrice || cartItem.price_unit || cartItem.price || 0);

      // Round to 2 decimals (Odoo currency rounding) then 3 for display
      const exactPrice = Math.round(Math.round(Number(rawPrice) * 100) / 100 * 1000) / 1000;

      addProduct({ ...cartItem, price_unit: exactPrice, price: exactPrice, original_price_unit: undefined, discount_percent: 0 });
    }

    // BACKGROUND: Sync to Odoo (non-blocking)
    (async () => {
      try {
        const { baseUrl, headers } = await _buildOdooHeadersLocal();
        const orderId = orderIdRef.current;

        // Set pricelist on order
        if (orderId) {
          await fetch(`${baseUrl}/web/dataset/call_kw`, {
            method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { model: 'pos.order', method: 'write', args: [[orderId], { pricelist_id: pricelistId }], kwargs: {} } }),
          });

          // Update each order line price in Odoo
          for (const cartItem of cartItems) {
            const pid = cartItem.remoteId || (typeof cartItem.id === 'number' ? cartItem.id : null);
            if (!pid) continue;
            const info = prodMap[pid];
            const tmplId = info?.tmplId;
            let rawPrice = (tmplId && plCache[tmplId] !== undefined) ? plCache[tmplId] : (info?.lstPrice || 0);
            const exactPrice = Math.round(Math.round(Number(rawPrice) * 100) / 100 * 1000) / 1000;

            const lineId = await getOdooLineId(cartItem);
            if (lineId) {
              try { await updateOrderLineOdoo({ lineId, price_unit: exactPrice, qty: Number(cartItem.qty ?? cartItem.quantity ?? 1), orderId }); } catch (_) {}
            }
          }
        }
      } catch (_) {}
    })();

    Toast.show({ type: 'success', text1: 'Pricelist changed', text2: pricelists.find(p => p.id === pricelistId)?.name || '' });
  }, [pricelists, pricelistItems, addProduct, getOdooLineId]);

  // Payment handler — uses existing draft order, adds payment, validates to 'paid'
  const handlePayNow = useCallback(async (cartItems) => {
    if (!cartItems.length) return;
    if (!selectedPayMethodId) { Alert.alert(t.paymentFailed, t.selectPaymentMethod); return; }

    const existingOrderId = orderIdRef.current;
    if (!existingOrderId) { Alert.alert(t.paymentFailed, 'No order found. Please add items first.'); return; }

    setPaying(true);
    try {
      const { baseUrl, headers } = await _buildOdooHeadersLocal();

      const totalAmt = computeCartTotal(cartItems);
      const selectedMethod = payMethods.find(m => m.id === selectedPayMethodId);
      const isCash = selectedMethod?.is_cash_count || String(selectedMethod?.name || '').toLowerCase().includes('cash');
      const paidAmt = isCash ? (parseFloat(payInputAmount) || totalAmt) : totalAmt;

      // Idempotency: reuse the same UUID across retries of this Pay Now attempt
      // so duplicate POSTs (double-tap, network retry) resolve to the SAME pos.payment
      // record on the server (requires pos_idempotent_create v19.0.3.0.0+).
      if (!paymentUuidRef.current) {
        const { generateUUIDv4 } = require('@utils/uuid');
        paymentUuidRef.current = generateUUIDv4();
      }

      // Step 1: Add payment record to the existing order
      const paymentVals = {
        pos_order_id: existingOrderId,
        amount: paidAmt,
        payment_method_id: selectedPayMethodId,
        session_id: sessionId || false,
        company_id: 1,
        client_uuid: paymentUuidRef.current,
      };

      const payResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
        method: 'POST', headers,
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call',
          params: { model: 'pos.payment', method: 'create', args: [paymentVals], kwargs: {} },
        }),
      });
      const payData = await payResp.json();
      if (payData?.error) {
        Alert.alert(t.paymentFailed, payData.error?.data?.message || payData.error?.message || 'Payment creation failed');
        return;
      }

      // Step 2: Update order amount_paid and state to 'paid'
      const updateResp = await fetch(`${baseUrl}/web/dataset/call_kw`, {
        method: 'POST', headers,
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call',
          params: {
            model: 'pos.order', method: 'write',
            args: [[existingOrderId], { amount_paid: paidAmt, amount_return: Math.max(0, paidAmt - totalAmt), state: 'paid' }],
            kwargs: {},
          },
        }),
      });
      const updateData = await updateResp.json();

      // Step 3: Try to validate/close the order via action_pos_order_paid
      try {
        await fetch(`${baseUrl}/web/dataset/call_kw`, {
          method: 'POST', headers,
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: { model: 'pos.order', method: 'action_pos_order_paid', args: [[existingOrderId]], kwargs: {} },
          }),
        });
      } catch (_) {}

      // Step 4: Clear cart and navigate
      try { clearProducts(); } catch (_) {}
      // Payment is confirmed on the server — release the idempotency key so
      // the NEXT Pay Now (different cart) generates a fresh UUID.
      paymentUuidRef.current = null;
      const isTakeaway = String(route?.params?.order_type || '').toUpperCase() === 'TAKEAWAY';
      if (isTakeaway) { try { await AsyncStorage.removeItem('active_takeaway_order'); } catch (_) {} }

      setPayModalVisible(false);
      setPayInputAmount('');

      Alert.alert(t.paymentSuccessful, t.orderClosedSuccess, [{
        text: t.ok || 'OK',
        onPress: () => {
          // Go back to the beginning so tables refresh properly
          navigation.reset({ index: 0, routes: [{ name: 'AppNavigator' }] });
        },
      }]);
    } catch (e) {
      Alert.alert(t.paymentFailed, e?.message || 'Failed to process payment');
    } finally {
      setPaying(false);
    }
  }, [sessionId, selectedPayMethodId, payInputAmount, payMethods, route?.params?.order_type, navigation, t, clearProducts, taxRateMap]);

  // Helper: get Odoo line ID from item (handles both odoo_line_ prefixed and raw IDs)
  const getOdooLineId = useCallback(async (item) => {
    if (String(item.id).startsWith('odoo_line_')) {
      return Number(String(item.id).replace('odoo_line_', ''));
    }
    // For items added from app — find the line in the server order
    const orderId = orderIdRef.current;
    if (!orderId) return null;
    try {
      const orderResp = await fetchPosOrderById(orderId);
      const lineIds = orderResp?.result?.lines ?? [];
      if (lineIds.length === 0) return null;
      const linesResp = await fetchOrderLinesByIds(lineIds);
      const lines = linesResp?.result ?? [];
      const productId = item.remoteId || item.id;
      const match = lines.find(l => {
        const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        if (pid !== productId) return false;
        if (item.note) return (l.customer_note || '') === item.note;
        return true;
      });
      return match ? match.id : null;
    } catch (_) {
      return null;
    }
  }, []);

  // Discount handler — apply discount % to a single product
  const handleApplyDiscount = useCallback(async (percent) => {
    if (!discountTargetItem) return;
    const item = discountTargetItem;
    const originalPrice = Number(item.original_price_unit ?? item.price_unit ?? item.price ?? 0);
    const discountedPrice = Math.round((originalPrice * (1 - percent / 100)) * 1000) / 1000;

    // Update in local cart
    addProduct({
      ...item,
      price_unit: discountedPrice,
      price: discountedPrice,
      original_price_unit: originalPrice,
      discount_percent: percent,
    });

    // Sync with Odoo
    const orderId = orderIdRef.current;
    if (orderId) {
      const lineId = await getOdooLineId(item);
      if (lineId) {
        try {
          await updateOrderLineOdoo({ lineId, qty: Number(item.qty ?? item.quantity ?? 1), price_unit: originalPrice, discount: percent, note: item.note || undefined, orderId });
        } catch (e) {
          Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to update discount in Odoo' });
        }
      }
    }

    setDiscountModalVisible(false);
    setDiscountTargetItem(null);
    Toast.show({ type: 'success', text1: `${percent}% discount applied`, text2: item.name });
  }, [discountTargetItem, addProduct, getOdooLineId]);

  // Remove discount from a product
  const handleRemoveDiscount = useCallback(async () => {
    if (!discountTargetItem) return;
    const item = discountTargetItem;
    const originalPrice = Number(item.original_price_unit ?? item.price_unit ?? item.price ?? 0);

    addProduct({
      ...item,
      price_unit: originalPrice,
      price: originalPrice,
      original_price_unit: undefined,
      discount_percent: 0,
    });

    const orderId = orderIdRef.current;
    if (orderId) {
      const lineId = await getOdooLineId(item);
      if (lineId) {
        try {
          await updateOrderLineOdoo({ lineId, qty: Number(item.qty ?? item.quantity ?? 1), price_unit: originalPrice, discount: 0, orderId });
        } catch (e) {}
      }
    }

    setDiscountModalVisible(false);
    setDiscountTargetItem(null);
    Toast.show({ type: 'info', text1: 'Discount removed', text2: item.name });
  }, [discountTargetItem, addProduct, getOdooLineId]);

  // Auto-save note to product (local + Odoo with debounce)
  const noteSyncTimer = useRef(null);
  const handleNoteChange = useCallback((text) => {
    setNoteText(text);
    if (!discountTargetItem) return;
    // Save locally immediately
    addProduct({ ...discountTargetItem, note: text });
    setDiscountTargetItem(prev => prev ? { ...prev, note: text } : null);

    // Debounce Odoo sync (800ms after last keystroke)
    if (noteSyncTimer.current) clearTimeout(noteSyncTimer.current);
    const itemRef = discountTargetItem;
    noteSyncTimer.current = setTimeout(async () => {
      const orderId = orderIdRef.current;
      if (orderId && itemRef) {
        const lineId = await getOdooLineId(itemRef);
        if (lineId) {
          try {
            await updateOrderLineOdoo({ lineId, note: text, orderId });
          } catch (_) {}
        }
      }
    }, 800);
  }, [discountTargetItem, addProduct, getOdooLineId]);

  // Cache all products
  const [allCachedProducts, setAllCachedProducts] = useState(null);

  const handleMainBack = useCallback(() => {
    setBackLoading(true);
    setTimeout(() => {
      try { navigation.goBack(); } catch (e) { navigation.navigate('Home'); }
    }, 80);
  }, [navigation]);

  const handleCloseProducts = useCallback(() => {
    setShowProducts(false);
    setSearchText('');
    setDebouncedSearch('');
    setSelectedPosCategoryId(null);
  }, []);

  // --- Persistent product name cache (survives screen remounts) ---
  const saveProductNames = useCallback(async (orderId, nameMap) => {
    if (!orderId || !nameMap) return;
    try { await AsyncStorage.setItem(`order_names_${orderId}`, JSON.stringify(nameMap)); } catch (_) {}
  }, []);

  const loadProductNames = useCallback(async (orderId) => {
    if (!orderId) return {};
    try {
      const raw = await AsyncStorage.getItem(`order_names_${orderId}`);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }, []);

  // Map pos.order.line -> product format
  const mapLineToProduct = useCallback((line) => {
    const productId = Array.isArray(line.product_id) ? line.product_id[0] : line.product_id;
    const nameFromProductId = Array.isArray(line.product_id) && line.product_id[1] ? String(line.product_id[1]) : '';
    const productName = line.full_product_name
      || (nameFromProductId || null)
      || (line.name && line.name !== '/' ? line.name : null)
      || line.display_name
      || line.product_name
      || 'Product';
    const qty = Number(line.qty || 1);
    const unitPrice = Number(line.price_unit || 0);
    const subtotalIncl = Number(line.price_subtotal_incl ?? line.price_subtotal ?? (qty * unitPrice));
    const discountPct = Number(line.discount || 0);
    const originalPrice = unitPrice;
    // Use Odoo's pre-calculated subtotal for exact price, avoid floating point errors
    const effectivePrice = discountPct > 0
      ? Math.round((originalPrice * (1 - discountPct / 100)) * 1000) / 1000
      : originalPrice;

    return {
      id: `odoo_line_${line.id}`,
      remoteId: productId,
      name: productName,
      price: effectivePrice,
      price_unit: effectivePrice,
      original_price_unit: discountPct > 0 ? originalPrice : undefined,
      discount_percent: discountPct,
      note: line.customer_note || '',
      quantity: qty,
      qty,
      price_subtotal: Number(line.price_subtotal ?? (qty * effectivePrice)),
      price_subtotal_incl: subtotalIncl,
    };
  }, []);

  // Load order from server — ONLY when local cart is empty (first open of this table)
  // Once items exist in local cart, NEVER overwrite them with server data
  const refreshServerOrder = useCallback(async (orderId) => {
    if (!orderId) return;
    const cartOwner = `order_${orderId}`;
    setCurrentCustomer(cartOwner);

    // Server is the source of truth. Merge bidirectionally: keep local items
    // that match a server line (preserves local notes/discounts), drop locals
    // that the server no longer has (deleted from another terminal), and
    // ADD any server lines that don't exist locally yet (added by another
    // terminal — e.g. web POS added items while we were on this screen).
    const localCart = useProductStore.getState().cartItems[cartOwner] || [];
    if (localCart.length > 0) {
      try {
        const orderResp = await fetchPosOrderById(orderId);
        const orderResult = orderResp?.result ?? null;
        setOrderInfo(orderResult);
        if (orderResult?.pricelist_id) {
          const plId = Array.isArray(orderResult.pricelist_id) ? orderResult.pricelist_id[0] : orderResult.pricelist_id;
          if (plId) { setActivePricelistId(plId); activePricelistRef.current = plId; }
        }
        const lineIds = orderResp?.result?.lines ?? [];
        if (lineIds.length === 0) {
          // Server has no lines anymore — clear local cart for this order.
          loadCustomerCart(cartOwner, []);
          return;
        }
        const linesResp = await fetchOrderLinesByIds(lineIds);
        const serverLines = linesResp?.result ?? [];

        const matchLocalForServerLine = (sl) => {
          const slProductId = Array.isArray(sl.product_id) ? sl.product_id[0] : sl.product_id;
          const slLineId = sl.id;
          return localCart.find(item => {
            const localLineId = String(item.id).startsWith('odoo_line_')
              ? Number(String(item.id).replace('odoo_line_', ''))
              : null;
            if (localLineId && localLineId === slLineId) return true;
            const localPid = item.remoteId || item.id;
            return localPid === slProductId;
          });
        };

        // For each server line: build the merged cart row
        const mergedCart = serverLines.map(sl => {
          const local = matchLocalForServerLine(sl);
          const mappedFromServer = mapLineToProduct(sl);
          if (local) {
            // Preserve local item identity, overlay server's discount/note/price
            const serverDiscount = Number(sl.discount || 0);
            const serverNote = sl.customer_note || '';
            const origPrice = Number(sl.price_unit || local.price_unit || local.price || 0);
            const effectivePrice = serverDiscount > 0
              ? Math.round((origPrice * (1 - serverDiscount / 100)) * 1000) / 1000
              : origPrice;
            return {
              ...local,
              quantity: mappedFromServer.quantity,
              qty: mappedFromServer.qty,
              price_subtotal: mappedFromServer.price_subtotal,
              price_subtotal_incl: mappedFromServer.price_subtotal_incl,
              note: serverNote,
              discount_percent: serverDiscount,
              price_unit: effectivePrice,
              price: effectivePrice,
              original_price_unit: serverDiscount > 0 ? origPrice : undefined,
            };
          }
          // No matching local — this is a NEW item from another terminal.
          return mappedFromServer;
        });
        loadCustomerCart(cartOwner, mergedCart);
      } catch (_) {}
      return;
    }

    // Local cart is empty — load from server (first time opening this table)
    try {
      const orderResp = await fetchPosOrderById(orderId);
      const orderResult = orderResp?.result ?? null;
      const CLOSED_STATES = ['done', 'receipt', 'paid', 'invoiced', 'posted', 'cancel'];
      if (orderResult && CLOSED_STATES.includes(String(orderResult.state))) {
        setLoadedOrderLines([]);
        setOrderInfo(orderResult);
        return;
      }
      const lineIds = orderResult?.lines ?? [];
      if (lineIds.length > 0) {
        const linesResp = await fetchOrderLinesByIds(lineIds);
        const lines = linesResp?.result ?? [];

        // Load saved product names from persistent storage
        const savedNames = await loadProductNames(orderId);

        // Merge server lines with the same product ID
        const mergedByProduct = {};
        const mergeOrder = [];
        lines.forEach(line => {
          const mapped = mapLineToProduct(line);
          const pid = mapped.remoteId;
          // Use composite key when note exists to keep separate lines
          const mergeKey = mapped.note ? `${pid}_note_${mapped.note}` : String(pid);
          if (mergedByProduct[mergeKey]) {
            mergedByProduct[mergeKey].quantity += mapped.quantity;
            mergedByProduct[mergeKey].qty += mapped.qty;
            const q = mergedByProduct[mergeKey].qty;
            const u = mergedByProduct[mergeKey].price_unit;
            mergedByProduct[mergeKey].price_subtotal = q * u;
            mergedByProduct[mergeKey].price_subtotal_incl = q * u;
          } else {
            if (pid && savedNames[pid]) {
              mapped.name = savedNames[pid];
              mapped.product_name = savedNames[pid];
            }
            mergedByProduct[mergeKey] = mapped;
            mergeOrder.push(mergeKey);
          }
        });

        const mergedItems = mergeOrder.map(key => mergedByProduct[key]);
        clearProducts();
        mergedItems.forEach(item => addProduct(item));
        setLoadedOrderLines(lines);
      }
      setOrderInfo(orderResult);
    } catch (err) {}
  }, [clearProducts, setCurrentCustomer, addProduct, mapLineToProduct, loadProductNames]);

  // Keep orderIdRef in sync if navigation params update (e.g. after lazy creation)
  useEffect(() => {
    if (route?.params?.orderId) orderIdRef.current = route.params.orderId;
  }, [route?.params?.orderId]);

  // Set cart owner on every focus, load from server only when cart is empty
  useFocusEffect(
    useCallback(() => {
      const orderId = orderIdRef.current;
      if (orderId) {
        try { setCurrentCustomer(`order_${orderId}`); } catch (e) {}
        (async () => { try { await refreshServerOrder(orderId); } catch (e) {} })();
      } else {
        // No order yet (takeaway before first product) — use temporary cart owner
        const tempOwner = route?.params?.cartOwner || 'pos_guest';
        try { setCurrentCustomer(tempOwner); } catch (e) {}
      }
    }, [route?.params?.orderId, route?.params?.cartOwner, setCurrentCustomer, refreshServerOrder])
  );

  // Live multi-terminal sync: while this screen is focused, poll the server
  // every 5 seconds so changes made on another terminal (web POS, sister tablet)
  // appear here without manual refresh. Paused on blur to save battery.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!isFocused) return;
    const orderId = orderIdRef.current;
    if (!orderId) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try { await refreshServerOrder(orderId); } catch (_) {}
    };
    const handle = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(handle); };
  }, [isFocused, refreshServerOrder, route?.params?.orderId]);

  // Eagerly fetch order state on mount (so buttons hide immediately for paid orders)
  useEffect(() => {
    const oid = orderIdRef.current || route?.params?.orderId;
    if (oid) {
      (async () => {
        try {
          const resp = await fetchPosOrderById(oid);
          if (resp?.result) setOrderInfo(resp.result);
        } catch (_) {}
      })();
    }
  }, []);

  // Load presets + order lines on mount
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetchPosPresets();
        if (resp?.result) {
          setPresets(resp.result);
          const dineIn = resp.result.find(p => String(p.name).toLowerCase().includes('dine'));
          setSelectedPreset(dineIn || resp.result[0] || null);
        }
      } catch (err) {}
    })();
    const { orderId, orderLines } = route?.params || {};
    if (orderLines && Array.isArray(orderLines) && orderLines.length > 0) {
      const cartOwner = `order_${orderId}`;
      // ALWAYS replace local cart with the server's view of this order on
      // re-entry. Multi-terminal POS: another terminal may have added items
      // since we last viewed this table — the server is the source of truth.
      const mappedItems = orderLines.map(line => mapLineToProduct(line));
      loadCustomerCart(cartOwner, mappedItems);
      setLoadedOrderLines(orderLines);
      // Then apply saved names asynchronously (updates in-place)
      (async () => {
        const savedNames = await loadProductNames(orderId);
        if (Object.keys(savedNames).length > 0) {
          const currentCart = useProductStore.getState().cartItems[cartOwner] || [];
          const updatedCart = currentCart.map(item => {
            const pid = item.remoteId;
            if (pid && savedNames[pid]) {
              return { ...item, name: savedNames[pid], product_name: savedNames[pid] };
            }
            return item;
          });
          loadCustomerCart(cartOwner, updatedCart);
        }
      })();
    }
  }, []);

  // Load categories on mount — use same API as home screen "Our Specials"
  useEffect(() => {
    (async () => {
      try {
        const [homeCategories, prodResp] = await Promise.all([
          fetchCategoriesOdoo({ offset: 0, limit: 100 }),
          fetchProductCategoriesOdoo(),
        ]);
        const catList = Array.isArray(homeCategories) ? homeCategories : [];
        // Map home-screen format (_id, name) to pos format (id, name)
        const mapped = catList.map(c => ({ id: c._id || c.id, name: c.name || c.category_name || '' }));
        setPosCategories(mapped);
        setProductCategories(Array.isArray(prodResp) ? prodResp : (prodResp?.result ?? []));
      } catch (e) {
        // Fallback: try raw pos categories
        try {
          const posResp = await fetchPosCategoriesOdoo();
          const posListRaw = Array.isArray(posResp) ? posResp : (posResp?.result ?? []);
          setPosCategories(posListRaw);
        } catch (_) {}
      }
    })();
  }, []);

  // Cache all products when modal opens
  useEffect(() => {
    if (!showProducts) return;
    let mounted = true;
    (async () => {
      try {
        const all = await preloadAllProducts();
        if (mounted) setAllCachedProducts(all);
      } catch (err) {}
    })();
    return () => { mounted = false; };
  }, [showProducts]);

  // Filter products by selected category — instant, no network
  useEffect(() => {
    if (!showProducts) return;
    if (!selectedPosCategoryId) { setPosFilteredProducts(null); return; }
    if (!allCachedProducts) return;
    const catId = Number(selectedPosCategoryId);
    const filtered = allCachedProducts.filter(p => {
      if (Array.isArray(p.pos_categ_ids) && p.pos_categ_ids.length > 0) return p.pos_categ_ids.includes(catId);
      if (Array.isArray(p.pos_categ_id)) return p.pos_categ_id[0] === catId;
      return p.pos_categ_id === catId;
    });
    setPosFilteredProducts(filtered);
  }, [selectedPosCategoryId, showProducts, allCachedProducts]);

  // Products to display — uses debounced search so filtering doesn't block touch events
  const productsToShow = useMemo(() => {
    const baseList = posFilteredProducts !== null ? posFilteredProducts : (allCachedProducts || []);
    let filtered = baseList;
    if (debouncedSearch && String(debouncedSearch).trim()) {
      const q = String(debouncedSearch).toLowerCase();
      filtered = Array.isArray(baseList) ? baseList.filter(p => {
        const name = String(p.product_name || p.name || '').toLowerCase();
        return name.includes(q);
      }) : baseList;
    }

    // Match Odoo POS cart display: pricelist fixed_price (if any) → else list_price,
    // then add each product's own tax on top (skipping taxes marked price_include).
    const plCache = pricelistItems?._cache?.[activePricelistId] || null;
    const prodMap = pricelistItems?._prodMap || null;

    return (Array.isArray(filtered) ? filtered : []).map(p => {
      const listP = Number(p.list_price ?? p.price ?? 0);
      let base = listP;
      if (plCache && prodMap) {
        const info = prodMap[p.id];
        const plPrice = info?.tmplId !== undefined ? plCache[info.tmplId] : undefined;
        if (plPrice !== undefined) base = Number(plPrice);
      }
      const taxIds = Array.isArray(p.taxes_id) ? p.taxes_id : [];
      let addOn = 0;
      taxIds.forEach(tid => {
        const t = taxRateMap[tid];
        if (t && !t.priceInclude) addOn += t.amount;
      });
      const displayPrice = Math.round(base * (1 + addOn / 100) * 1000) / 1000;
      return { ...p, displayPrice };
    });
  }, [posFilteredProducts, allCachedProducts, debouncedSearch, taxRateMap, activePricelistId, pricelistItems]);

  // Helper: ensure an orderId exists — creates the draft order lazily for takeaway
  const ensureOrderId = useCallback(async () => {
    if (orderIdRef.current) return orderIdRef.current;
    // Create the draft order on the server now
    const created = await createDraftPosOrderOdoo({
      sessionId,
      userId,
      tableId: route?.params?.tableId || false,
      preset_id: route?.params?.preset_id || 10,
      order_type: route?.params?.order_type || 'TAKEAWAY',
    });
    if (created && created.result) {
      orderIdRef.current = created.result;
      const cartOwner = `order_${created.result}`;
      // Move current cart items to the new order's cart owner
      const currentCart = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
      loadCustomerCart(cartOwner, currentCart);
      // Update navigation params so other screens can access the orderId
      navigation.setParams({ orderId: created.result, cartOwner });
      return created.result;
    }
    throw new Error('Failed to create order');
  }, [sessionId, userId, route?.params?.tableId, route?.params?.preset_id, route?.params?.order_type, loadCustomerCart, navigation]);

  const handleAdd = useCallback((p, qtyOverride = 1, note = '') => {
    const productName = p.product_name || p.name || p.display_name || p.full_product_name || `Product #${p.id}`;
    let productPrice = p.price || p.list_price || 0;

    // Use cached pricelist price for the active pricelist (instant, no API)
    const currentPlId = activePricelistRef.current;
    const plRef = pricelistItemsRef.current;
    if (currentPlId && plRef?._cache && plRef?._prodMap) {
      const plCache = plRef._cache[currentPlId];
      const prodInfo = plRef._prodMap[p.id];
      if (plCache && prodInfo?.tmplId && plCache[prodInfo.tmplId] !== undefined) {
        productPrice = Math.round(Math.round(Number(plCache[prodInfo.tmplId]) * 100) / 100 * 1000) / 1000;
      }
    }

    const hasNote = note && note.trim().length > 0;

    if (hasNote) {
      // Note provided — ALWAYS create a separate line with unique ID
      const uniqueId = `${p.id}_${Date.now()}`;
      const product = {
        id: uniqueId,
        remoteId: p.id,
        name: productName,
        product_name: productName,
        price: productPrice,
        price_unit: productPrice,
        quantity: qtyOverride,
        imageUrl: p.imageUrl || p.image_url || p.image || '',
        taxes_id: Array.isArray(p.taxes_id) ? p.taxes_id : [],
        note: note.trim(),
      };
      addProduct(product);

      ensureOrderId().then(orderId => {
        const promise = addLineToOrderOdoo({ orderId, productId: p.id, qty: qtyOverride, price_unit: productPrice, name: productName, note: note.trim() })
          .catch(() => Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to sync with server' }))
          .finally(() => { pendingSyncs.current = pendingSyncs.current.filter(pr => pr !== promise); });
        pendingSyncs.current.push(promise);
      }).catch(() => Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to create order' }));
    } else {
      // No note — existing merge behavior
      const localCart = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
      const existing = localCart.find(item => {
        if (item.note) return false; // Don't merge into items that have notes
        const itemProductId = item.remoteId || (typeof item.id === 'number' ? item.id : null);
        return itemProductId === p.id;
      });

      if (existing) {
        const newQty = Number(existing.quantity ?? existing.qty ?? 1) + qtyOverride;
        addProduct({ ...existing, quantity: newQty, qty: newQty });

        const orderId = orderIdRef.current;
        if (orderId && String(existing.id).startsWith('odoo_line_')) {
          const lineId = Number(String(existing.id).replace('odoo_line_', ''));
          const promise = updateOrderLineOdoo({ lineId, qty: newQty, price_unit: existing.price_unit ?? existing.price, orderId })
            .catch(() => Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to update quantity' }))
            .finally(() => { pendingSyncs.current = pendingSyncs.current.filter(pr => pr !== promise); });
          pendingSyncs.current.push(promise);
        } else if (orderId) {
          const promise = addLineToOrderOdoo({ orderId, productId: p.id, qty: qtyOverride, price_unit: productPrice, name: productName })
            .catch(() => Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to sync with server' }))
            .finally(() => { pendingSyncs.current = pendingSyncs.current.filter(pr => pr !== promise); });
          pendingSyncs.current.push(promise);
        }
      } else {
        const product = {
          id: p.id,
          remoteId: p.id,
          name: productName,
          product_name: productName,
          price: productPrice,
          price_unit: productPrice,
          quantity: qtyOverride,
          imageUrl: p.imageUrl || p.image_url || p.image || '',
          taxes_id: Array.isArray(p.taxes_id) ? p.taxes_id : [],
        };
        addProduct(product);

        ensureOrderId().then(orderId => {
          const promise = addLineToOrderOdoo({ orderId, productId: p.id, qty: qtyOverride, price_unit: productPrice, name: productName })
            .catch(() => Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to sync with server' }))
            .finally(() => { pendingSyncs.current = pendingSyncs.current.filter(pr => pr !== promise); });
          pendingSyncs.current.push(promise);
        }).catch(() => Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to create order' }));
      }
    }

    // Persist the product name so it survives screen remounts
    const orderId = orderIdRef.current;
    if (orderId && p.id) {
      loadProductNames(orderId).then(nameMap => {
        nameMap[p.id] = productName;
        saveProductNames(orderId, nameMap);
      }).catch(() => {});
    }
  }, [addProduct, loadProductNames, saveProductNames, ensureOrderId]);

  const openQuickAdd = useCallback((p) => {
    setConfirmVisible(false);
    setQuickProduct(p);
    setQuickQty(1);
    setQuickNote('');
    setQuickAddVisible(true);
  }, []);

  const _doConfirmQuickAdd = useCallback(() => {
    if (!quickProduct) return;
    const addedName = quickProduct.product_name || quickProduct.name || 'Product';
    const addedQty = quickQty;
    const addedNote = quickNote.trim();
    const prodToAdd = quickProduct;
    setQuickAddVisible(false);
    setConfirmName(addedName);
    setConfirmQty(addedQty);
    setConfirmVisible(true);
    setQuickProduct(null);
    setQuickQty(1);
    setQuickNote('');
    InteractionManager.runAfterInteractions(() => handleAdd(prodToAdd, addedQty, addedNote));
    setTimeout(() => setConfirmVisible(false), 1000);
  }, [quickProduct, quickQty, quickNote, handleAdd]);
  const confirmQuickAdd = usePressOnce(_doConfirmQuickAdd);

  const handleViewCart = useCallback(() => {
    // Sync with server before showing cart
    const orderId = orderIdRef.current;
    if (orderId) {
      refreshServerOrder(orderId).catch(() => {});
    }
    navigation.navigate('POSCartSummary', { openingAmount, sessionId, registerId, registerName, userId, userName });
  }, [navigation, openingAmount, sessionId, registerId, registerName, userId, userName, refreshServerOrder]);

  const renderItem = useCallback(({ item }) => {
    if (item.empty) return <View style={[styles.itemStyle, styles.itemInvisible]} />;
    return (
      <ProductsList
        item={item}
        onPress={() => {}}
        showQuickAdd
        onQuickAdd={openQuickAdd}
      />
    );
  }, [openQuickAdd]);

  const renderEmptyState = () => (
    <EmptyState imageSource={require('@assets/images/EmptyData/empty_data.png')} message={''} />
  );

  const renderOrderLine = ({ item, index }) => {
    const qty = Number(item.qty ?? item.quantity ?? 1);
    const unit = Number(item.price_unit ?? item.price ?? 0);
    const subtotal = computeLineTotal(item);

    const handleIncrease = async () => {
      const newQty = qty + 1;
      const orderId = orderIdRef.current;
      addProduct({ ...item, quantity: newQty, qty: newQty });
      if (orderId) {
        const lineId = await getOdooLineId(item);
        if (lineId) {
          try {
            await updateOrderLineOdoo({ lineId, qty: newQty, price_unit: item.price_unit ?? item.price, orderId });
          } catch (e) {
            Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to update quantity' });
            try { await refreshServerOrder(orderId); } catch (_) {}
          }
        } else if (item.remoteId) {
          try {
            await addLineToOrderOdoo({ orderId, productId: item.remoteId || item.id, qty: 1, price_unit: item.price_unit ?? item.price, name: item.name });
          } catch (e) {
            Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to add product to order' });
            try { await refreshServerOrder(orderId); } catch (_) {}
          }
        }
      }
    };

    const handleDecrease = async () => {
      const orderId = orderIdRef.current;
      if (qty <= 1) {
        removeProduct(item.id);
        if (orderId) {
          const lineId = await getOdooLineId(item);
          if (lineId) {
            try { await removeOrderLineOdoo({ lineId, orderId }); } catch (_) {}
          }
          try { await refreshServerOrder(orderId); } catch (_) {}
        }
      } else {
        const newQty = qty - 1;
        addProduct({ ...item, quantity: newQty, qty: newQty });
        if (orderId) {
          const lineId = await getOdooLineId(item);
          if (lineId) {
            try {
              await updateOrderLineOdoo({ lineId, qty: newQty, price_unit: item.price_unit ?? item.price, orderId });
            } catch (e) {
              Toast.show({ type: 'error', text1: 'Odoo Error', text2: 'Failed to update quantity' });
              try { await refreshServerOrder(orderId); } catch (_) {}
            }
          }
        }
      }
    };

    const discountPct = Number(item.discount_percent || 0);

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => { if (isOrderClosed) return; setDiscountTargetItem(item); setNoteText(item.note || ''); setDiscountModalVisible(true); }}
        style={localStyles.orderLineRow}
      >
        <Text style={[localStyles.orderLineSno, { textAlign: 'center' }]}>{index + 1}.</Text>
        <View style={localStyles.rowDivider} />
        <View style={{ flex: 1 }}>
          <Text style={localStyles.orderLineName}>{item.name || item.full_product_name || item.product_name || (Array.isArray(item.product_id) ? item.product_id[1] : null) || `Product #${item.remoteId || item.id}`}</Text>
          {discountPct > 0 ? (
            <>
              <View style={localStyles.discountInfoRow}>
                <View style={localStyles.discountBadge}>
                  <Text style={localStyles.discountBadgeText}>-{discountPct}%</Text>
                </View>
                <Text style={localStyles.discountOrigPrice}>{formatCurrency(Number(item.original_price_unit)).replace(/^\w+\s/, '')}</Text>
                <Text style={localStyles.discountArrow}>→</Text>
                <Text style={localStyles.discountNewPrice}>{formatCurrency(unit).replace(/^\w+\s/, '')} {t.each}</Text>
              </View>
            </>
          ) : (
            <Text style={localStyles.orderLinePrice}>{formatCurrency(unit).replace(/^\w+\s/, '')} {t.each}</Text>
          )}
          {item.note ? <Text style={localStyles.orderLineNote}>📝 {item.note}</Text> : null}
        </View>
        <View style={localStyles.rowDivider} />
        <View style={localStyles.orderLineControls}>
          {!isOrderClosed ? (
            <>
              <TouchableOpacity onPress={handleDecrease} style={localStyles.orderLineBtn}>
                <Text style={localStyles.orderLineBtnText}>-</Text>
              </TouchableOpacity>
              <Text style={localStyles.orderLineQty}>{qty}</Text>
              <TouchableOpacity onPress={handleIncrease} style={localStyles.orderLineBtn}>
                <Text style={localStyles.orderLineBtnText}>+</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={localStyles.orderLineQty}>{qty}</Text>
          )}
        </View>
        <View style={localStyles.rowDivider} />
        <Text style={localStyles.orderLineTotal}>{formatCurrency(subtotal)}</Text>
      </TouchableOpacity>
    );
  };

  const onKitchenBillPress = usePressOnce(async () => {
    const cartItems = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
    console.log('[KitchenBill] button pressed, order_type=', route?.params?.order_type, 'cartItems=', cartItems.length);
    if (pendingSyncs.current.length > 0) {
      try { await Promise.all(pendingSyncs.current); } catch (_) {}
    }
    const orderId = orderIdRef.current || orderInfo?.id;
    const baseParams = {
      orderId, orderName: orderInfo?.name || '', tableName: orderInfo?.table_id?.[1] || '',
      serverName: route?.params?.userName || '', items: cartItems,
      cartOwner: route?.params?.cartOwner || (orderId ? `order_${orderId}` : 'pos_guest'),
      order_type: route?.params?.order_type,
      sessionId,
      userId,
    };
    console.log('[KitchenBill] calling openKotWizard with orderId=', orderId, 'tableName=', baseParams.tableName);
    openKotWizard(baseParams);
  });

  const onPayNowPress = usePressOnce(() => {
    if (!payUnlocked) {
      setPinInput('');
      setPinError(false);
      setPinModalVisible(true);
      return;
    }
    const cartItems = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
    const totalAmt = computeCartTotal(cartItems);
    setPayInputAmount(totalAmt.toFixed(3));
    setPayModalVisible(true);
  });

  const submitPin = () => {
    if (expectedPin && pinInput === expectedPin) {
      setPayUnlocked(true);
      setPinModalVisible(false);
      setPinInput('');
      setPinError(false);
      // Open the payment method popup immediately — user shouldn't have to tap Pay Now again.
      const cartItems = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
      const totalAmt = computeCartTotal(cartItems);
      setPayInputAmount(totalAmt.toFixed(3));
      setPayModalVisible(true);
    } else {
      setPinError(true);
    }
  };

  const onPayConfirmPress = usePressOnce(async () => {
    const cartItems = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
    await handlePayNow(cartItems);
  });

  const computeLineTotal = useCallback((it) => {
    const itQty = Number(it.quantity ?? it.qty ?? 1);
    const itUnit = Number(it.price_unit ?? it.price ?? 0);
    const net = itQty * itUnit;

    // Resolve taxes_id: prefer what's stored on the cart item, fall back to the
    // product catalog lookup (for server-loaded orders where the line doesn't
    // carry taxes_id).
    let taxIds = Array.isArray(it.taxes_id) ? it.taxes_id : null;
    if (!taxIds || taxIds.length === 0) {
      const pid = it.remoteId || (typeof it.id === 'number' ? it.id : null);
      const prodInfo = pid ? pricelistItems?._prodMap?.[pid] : null;
      if (prodInfo && Array.isArray(prodInfo.taxesId)) taxIds = prodInfo.taxesId;
    }
    taxIds = taxIds || [];

    let addOn = 0;
    taxIds.forEach(tid => {
      const t = taxRateMap[tid];
      if (t && !t.priceInclude) addOn += t.amount;
    });
    return Math.round(net * (1 + addOn / 100) * 1000) / 1000;
  }, [taxRateMap, pricelistItems]);

  const computeCartTotal = useCallback((items) => {
    return (items || []).reduce((s, it) => s + computeLineTotal(it), 0);
  }, [computeLineTotal]);

  // Break the cart total into subtotal (net) + tax so the register can show both.
  // Handles BOTH tax modes:
  //   - tax-exclusive: line price is net, tax adds on top  (Subtotal=net, Total=net+tax)
  //   - tax-inclusive: line price already contains tax     (Subtotal=net (extracted), Total=gross)
  const computeCartBreakdown = useCallback((items) => {
    let subtotal = 0;
    let total = 0;
    (items || []).forEach(it => {
      const lineTotal = computeLineTotal(it);
      total += lineTotal;

      let lineSubtotal;
      // Prefer Odoo's pre-computed net subtotal if the line came from server.
      if (it.price_subtotal !== undefined && it.price_subtotal !== null) {
        lineSubtotal = Number(it.price_subtotal) || 0;
      } else {
        // Locally-added item: extract net from gross when any of its taxes is tax-inclusive.
        const qty = Number(it.quantity ?? it.qty ?? 1);
        const unit = Number(it.price_unit ?? it.price ?? 0);
        const grossLine = qty * unit;
        const taxIds = Array.isArray(it.taxes_id) ? it.taxes_id : [];
        const inclusiveTaxRate = taxIds.reduce((sum, tid) => {
          const tx = taxRateMap[tid];
          return tx && tx.priceInclude ? sum + (tx.amount || 0) : sum;
        }, 0);
        lineSubtotal = inclusiveTaxRate > 0
          ? grossLine / (1 + inclusiveTaxRate / 100)
          : grossLine;
      }
      subtotal += lineSubtotal;
    });
    subtotal = Math.round(subtotal * 1000) / 1000;
    total = Math.round(total * 1000) / 1000;
    const tax = Math.round((total - subtotal) * 1000) / 1000;
    return { subtotal, tax, total };
  }, [computeLineTotal, taxRateMap]);

  const renderRegisterPanel = () => {
    const cartItems = useProductStore((s) => s.getCurrentCart()) || [];
    const { subtotal, tax, total } = computeCartBreakdown(cartItems);

    return (
      <View style={localStyles.registerPanel}>
        {/* Header with order name and user badge */}
        <View style={localStyles.registerHeader}>
          <View style={{ flex: 1 }}>
            <Text style={localStyles.registerTitle}>{route?.params?.registerName || t.register}</Text>
            {/* Prefer pos_reference (260-1-000005) so the receipt number matches what
                the web POS shows. Fall back to name, then to internal id. */}
            {orderInfo?.pos_reference
              ? <Text style={localStyles.registerOrderName}>{orderInfo.pos_reference}</Text>
              : (orderInfo?.name && orderInfo.name !== '/'
                  ? <Text style={localStyles.registerOrderName}>{orderInfo.name}</Text>
                  : (orderInfo?.id ? <Text style={localStyles.registerOrderName}>{t.order} #{orderInfo.id}</Text> : null))}
          </View>
          <View style={localStyles.registerUserBadge}>
            <Text style={localStyles.registerUserText}>{route?.params?.userName || t.staff}</Text>
          </View>
        </View>

        {/* Pricelist Toggle — only Dine In and Application buttons */}
        {(() => {
          const talabatPl = pricelists.find(p => p.name?.toLowerCase().includes('talabat') || p.name?.toLowerCase().includes('application'));
          const normalPl = pricelists.find(p => p.id !== talabatPl?.id);
          if (!talabatPl || !normalPl) return null;
          return (
            <View style={localStyles.pricelistRow}>
              <TouchableOpacity
                style={[localStyles.pricelistBtn, activePricelistId === normalPl.id && localStyles.pricelistBtnNormal]}
                onPress={() => handleSwitchPricelist(normalPl.id)}
                activeOpacity={0.7}
              >
                <Text style={[localStyles.pricelistBtnText, activePricelistId === normalPl.id && localStyles.pricelistBtnTextActive]}>DINE IN PRICE</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[localStyles.pricelistBtn, activePricelistId === talabatPl.id && localStyles.pricelistBtnTalabat]}
                onPress={() => handleSwitchPricelist(talabatPl.id)}
                activeOpacity={0.7}
              >
                <Text style={[localStyles.pricelistBtnText, activePricelistId === talabatPl.id && localStyles.pricelistBtnTextActive]}>APPLICATION PRICE</Text>
              </TouchableOpacity>
            </View>
          );
        })()}

        {/* Column header */}
        <View style={localStyles.columnHeader}>
          <Text style={[localStyles.colHeaderText, { width: 24, textAlign: 'center' }]}>#</Text>
          <View style={localStyles.colDivider} />
          <Text style={[localStyles.colHeaderText, { flex: 1 }]}>{t.items}</Text>
          <View style={localStyles.colDivider} />
          <Text style={[localStyles.colHeaderText, { width: 130, textAlign: 'center' }]}>{t.qty}</Text>
          <View style={localStyles.colDivider} />
          <Text style={[localStyles.colHeaderText, { width: 80, textAlign: 'right' }]}>{t.amount}</Text>
        </View>

        {/* Order lines */}
        <View style={{ flex: 1 }}>
          <FlatList
            data={cartItems}
            keyExtractor={item => String(item.id)}
            renderItem={renderOrderLine}
            ListEmptyComponent={
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Text style={{ fontSize: 36, marginBottom: 8 }}>🛒</Text>
                <Text style={{ color: '#8896ab', fontWeight: '600', fontSize: 14 }}>{t.noItemsYet}</Text>
                <Text style={{ color: '#b0bec5', fontSize: 12, marginTop: 4 }}>{t.tapAddProducts}</Text>
              </View>
            }
            contentContainerStyle={{ paddingBottom: 6 }}
          />
        </View>

        {/* Subtotal + Taxes + Total breakdown */}
        <View style={localStyles.totalSection}>
          <View style={localStyles.breakdownRow}>
            <Text style={localStyles.breakdownLabel}>Subtotal</Text>
            <Text style={localStyles.breakdownValue}>{formatCurrency(subtotal)}</Text>
          </View>
          {tax > 0 && (
            <View style={localStyles.breakdownRow}>
              <Text style={localStyles.breakdownLabel}>Taxes</Text>
              <Text style={localStyles.breakdownValue}>{formatCurrency(tax)}</Text>
            </View>
          )}
          <View style={localStyles.totalRow}>
            <Text style={localStyles.totalLabel}>{t.total}</Text>
            <Text style={localStyles.totalValue}>{formatCurrency(total)}</Text>
          </View>
        </View>

        {/* Bottom action — hidden for paid/closed orders */}
        {!isOrderClosed && (
        <View style={localStyles.bottomActions}>
          <TouchableOpacity disabled={cartItems.length === 0} onPress={onKitchenBillPress} style={[localStyles.kitchenBillBtn, cartItems.length === 0 && { opacity: 0.4 }]}>
            <Text style={localStyles.kitchenBillBtnText}>{t.kitchenBill}</Text>
          </TouchableOpacity>

          {/* Payment Button — locked behind PIN until unlocked for the session */}
          <TouchableOpacity
            disabled={cartItems.length === 0}
            onPress={onPayNowPress}
            style={[localStyles.payNowBtn, cartItems.length === 0 && { opacity: 0.4 }]}
            activeOpacity={0.85}
          >
            <Text style={localStyles.payNowBtnText}>
              {payUnlocked ? '✅' : '🔒'}  {t.payNow}  💰  {formatCurrency(computeCartTotal(cartItems))}
            </Text>
          </TouchableOpacity>
        </View>
        )}
      </View>
    );
  };

  const renderProducts = () => {
    if ((!productsToShow || productsToShow.length === 0) && !(!allCachedProducts)) return renderEmptyState();
    return (
      <FlashList
        data={formatData(productsToShow, 3)}
        numColumns={3}
        renderItem={renderItem}
        keyExtractor={(item, index) => String(item.id || index)}
        contentContainerStyle={localStyles.productsList}
        showsVerticalScrollIndicator={false}
        onEndReachedThreshold={0.2}
        estimatedItemSize={150}
        drawDistance={300}
        keyboardShouldPersistTaps="handled"
      />
    );
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <NavigationHeader title={t.register} onBackPress={handleMainBack} logo={false} />
      <OverlayLoader visible={backLoading} />
      <View style={{ flex: 1, paddingHorizontal: 14, backgroundColor: '#f0f2f8' }}>
        {renderRegisterPanel()}

        {!isOrderClosed && (
          <View style={localStyles.addProductsBtn}>
            <Button title={t.addProducts} onPress={() => setShowProducts(true)} />
          </View>
        )}

        <Modal visible={showProducts} animationType="slide" onRequestClose={handleCloseProducts}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#f0f2f8' }}>
            {/* Modern header bar */}
            <View style={localStyles.productsHeader}>
              <TouchableOpacity onPress={handleCloseProducts} style={localStyles.productsBackBtn} activeOpacity={0.7}>
                <AntDesign name="left" size={22} color="#fff" />
              </TouchableOpacity>
              <Text style={localStyles.productsHeaderTitle}>{t.products}</Text>
              <View style={{ width: 40 }} />
            </View>

            {/* Search bar */}
            <View style={localStyles.productsSearchWrap}>
              <View style={localStyles.productsSearchBar}>
                <Text style={{ fontSize: 16, marginRight: 10 }}>🔍</Text>
                <TextInput
                  placeholder={t.searchProducts}
                  placeholderTextColor="#9ca3af"
                  onChangeText={handleSearchChange}
                  value={searchText}
                  style={localStyles.productsSearchInput}
                />
              </View>
            </View>

            {/* Category pills */}
            <View style={localStyles.catBar}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={localStyles.catScroll} keyboardShouldPersistTaps="handled">
                <TouchableOpacity onPress={() => setSelectedPosCategoryId(null)} style={{ marginRight: 8 }}>
                  <View style={[localStyles.catPill, selectedPosCategoryId === null ? { backgroundColor: '#2E294E', borderColor: '#2E294E' } : { backgroundColor: '#f3f4f6' }]}>
                    <Text style={[localStyles.catText, { color: selectedPosCategoryId === null ? '#fff' : '#374151' }]}>{t.showAll}</Text>
                  </View>
                </TouchableOpacity>
                {posCategories.length > 0 ? (
                  posCategories.map(cat => {
                    const id = cat.id || (Array.isArray(cat) ? cat[0] : null);
                    const name = cat.name || (Array.isArray(cat) ? cat[1] : '');
                    const selected = Number(id) === Number(selectedPosCategoryId);
                    return (
                      <TouchableOpacity key={String(id)} onPress={() => setSelectedPosCategoryId(id)} style={{ marginRight: 8 }}>
                        <View style={[localStyles.catPill, selected ? { backgroundColor: '#2E294E', borderColor: '#2E294E' } : { backgroundColor: '#f3f4f6' }]}>
                          <Text style={[localStyles.catText, { color: selected ? '#fff' : '#374151' }]}>{name}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })
                ) : (
                  <Text style={{ color: '#999', fontWeight: '600', fontSize: 13 }}>{t.loadingCategories}</Text>
                )}
              </ScrollView>
            </View>

            {/* Products grid */}
            <View style={{ flex: 1, backgroundColor: '#fff' }}>
              {renderProducts()}
            </View>

            {/* Quick Add Modal */}
            <Modal visible={quickAddVisible} transparent animationType="none" onRequestClose={() => setQuickAddVisible(false)}>
              <Pressable style={localStyles.modalBackdrop} onPress={() => setQuickAddVisible(false)}>
                <Pressable style={localStyles.modalCard} onPress={(e) => e.stopPropagation()}>
                  <Text style={localStyles.modalTitle}>{t.addItem}</Text>
                  <Text style={localStyles.modalSubtitle}>{quickProduct?.product_name || quickProduct?.name || 'Product'}</Text>
                  <View style={localStyles.qtyRow}>
                    <Text style={localStyles.qtyLabel}>{t.quantity}</Text>
                    <View style={localStyles.qtyButtons}>
                      <TouchableOpacity onPress={() => setQuickQty(prev => Math.max(1, prev - 1))} style={localStyles.qtyBtn} activeOpacity={0.6}>
                        <Text style={localStyles.qtyText}>-</Text>
                      </TouchableOpacity>
                      <Text style={localStyles.qtyDisplay}>{quickQty}</Text>
                      <TouchableOpacity onPress={() => setQuickQty(prev => prev + 1)} style={localStyles.qtyBtn} activeOpacity={0.6}>
                        <Text style={localStyles.qtyText}>+</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  {/* Note input */}
                  <View style={{ marginTop: 12 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#1a1a2e', marginBottom: 6 }}>{t.notes || 'Note'}</Text>
                    <TextInput
                      style={localStyles.noteInput}
                      value={quickNote}
                      onChangeText={setQuickNote}
                      placeholder="e.g. no sugar, extra ice..."
                      placeholderTextColor="#bbb"
                      multiline
                      textAlignVertical="top"
                    />
                  </View>
                  <View style={localStyles.divider} />
                  <View style={localStyles.actionRow}>
                    <TouchableOpacity onPress={() => setQuickAddVisible(false)} style={localStyles.cancelBtn}>
                      <Text style={localStyles.cancelText}>{t.cancel}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={confirmQuickAdd} style={[localStyles.addBtn, { backgroundColor: COLORS.primary || '#111827' }]}>
                      <Text style={localStyles.addBtnText}>{t.addToCart}</Text>
                    </TouchableOpacity>
                  </View>
                </Pressable>
              </Pressable>
            </Modal>

            {/* Confirmation chip — non-blocking */}
            {confirmVisible && (
              <View pointerEvents="none" style={localStyles.confirmOverlay}>
                <View style={localStyles.confirmChip}>
                  <Text style={localStyles.confirmTitle}>{t.addedToCart}</Text>
                  <Text style={localStyles.confirmSub}>{confirmName} × {confirmQty}</Text>
                </View>
              </View>
            )}

            {/* Floating "Go to Register" button */}
            <TouchableOpacity
              onPress={handleCloseProducts}
              style={localStyles.floatingRegisterBtn}
              activeOpacity={0.85}
            >
              <Text style={{ fontSize: 16, marginRight: 8 }}>🛒</Text>
              <Text style={localStyles.floatingRegisterText}>{t.goToRegister}</Text>
            </TouchableOpacity>
          </SafeAreaView>
        </Modal>
      </View>

      {/* ── PIN Gate Modal ───────────────────────────────────── */}
      <Modal visible={pinModalVisible} transparent animationType="fade" onRequestClose={() => setPinModalVisible(false)}>
        <View style={localStyles.pinOverlay}>
          <View style={localStyles.pinCard}>
            <View style={localStyles.pinHeader}>
              <Text style={localStyles.pinTitle}>🔒  Enter Payment PIN</Text>
              <TouchableOpacity onPress={() => setPinModalVisible(false)}>
                <Text style={localStyles.pinClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={localStyles.pinHint}>Enter the PIN to unlock payments for this session.</Text>
            <TextInput
              style={[localStyles.pinInput, pinError && { borderColor: '#e53935' }]}
              value={pinInput}
              onChangeText={(v) => { setPinInput(v); if (pinError) setPinError(false); }}
              placeholder="PIN"
              placeholderTextColor="#bbb"
              secureTextEntry
              autoFocus
              onSubmitEditing={submitPin}
              returnKeyType="done"
            />
            {pinError && <Text style={localStyles.pinErrText}>Incorrect PIN. Try again.</Text>}
            <TouchableOpacity style={localStyles.pinSubmitBtn} onPress={submitPin} activeOpacity={0.85}>
              <Text style={localStyles.pinSubmitText}>Unlock</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Payment Modal ─────────────────────────────────────── */}
      <Modal visible={payModalVisible} transparent animationType="slide" onRequestClose={() => setPayModalVisible(false)}>
        <View style={localStyles.payModalOverlay}>
          <View style={localStyles.payModalCard}>
            <View style={localStyles.payModalHeader}>
              <Text style={localStyles.payModalTitle}>{t.selectPaymentMethod}</Text>
              <TouchableOpacity onPress={() => setPayModalVisible(false)}>
                <Text style={localStyles.payModalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {(() => {
              const cartItems = useProductStore.getState().cartItems[useProductStore.getState().currentCustomerId] || [];
              const { subtotal: subAmt, tax: taxAmt, total: totalAmt } = computeCartBreakdown(cartItems);
              const paidNum = parseFloat(payInputAmount) || 0;
              const changeAmt = paidNum - totalAmt;

              return (
                <>
                  <View style={localStyles.payTotalBox}>
                    <View style={{ width: '100%' }}>
                      <View style={localStyles.breakdownRow}>
                        <Text style={localStyles.breakdownLabel}>Subtotal</Text>
                        <Text style={localStyles.breakdownValue}>{formatCurrency(subAmt)}</Text>
                      </View>
                      {taxAmt > 0 && (
                        <View style={localStyles.breakdownRow}>
                          <Text style={localStyles.breakdownLabel}>Taxes</Text>
                          <Text style={localStyles.breakdownValue}>{formatCurrency(taxAmt)}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[localStyles.payTotalLabel, { marginTop: 8 }]}>{t.orderTotal}</Text>
                    <Text style={localStyles.payTotalValue}>{formatCurrency(totalAmt)}</Text>
                  </View>

                  {/* Dynamic payment methods from Odoo */}
                  <ScrollView style={{ marginBottom: 16, maxHeight: payMethods.length > 6 ? 320 : undefined }} showsVerticalScrollIndicator={payMethods.length > 6}>
                    {payMethods.map(m => {
                      const isSelected = selectedPayMethodId === m.id;
                      const icon = m.is_cash_count || String(m.name).toLowerCase().includes('cash') ? '💵'
                        : String(m.name).toLowerCase().includes('card') ? '💳'
                        : String(m.name).toLowerCase().includes('bank') ? '🏦'
                        : '💳';
                      return (
                        <TouchableOpacity
                          key={m.id}
                          style={[localStyles.payMethodRow, isSelected && localStyles.payMethodRowActive]}
                          onPress={() => setSelectedPayMethodId(m.id)}
                          activeOpacity={0.7}
                        >
                          <Text style={localStyles.payModeIcon}>{icon}</Text>
                          <Text style={[localStyles.payMethodName, isSelected && localStyles.payMethodNameActive]}>{m.name}</Text>
                          {isSelected && <Text style={localStyles.payMethodCheck}>✓</Text>}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>

                  {/* Amount input for cash methods */}
                  {(() => {
                    const selMethod = payMethods.find(m => m.id === selectedPayMethodId);
                    const isCashMethod = selMethod?.is_cash_count || String(selMethod?.name || '').toLowerCase().includes('cash');
                    if (!isCashMethod) return null;
                    return (
                      <View style={{ marginBottom: 20 }}>
                        <Text style={localStyles.payAmountLabel}>{t.amountReceived}</Text>
                        <TextInput
                          style={localStyles.payAmountInput}
                          value={payInputAmount}
                          onChangeText={setPayInputAmount}
                          keyboardType="numeric"
                          placeholder="0.000"
                          placeholderTextColor="#bbb"
                        />
                        {changeAmt > 0 && <Text style={localStyles.payChangeText}>{t.change}: {changeAmt.toFixed(3)}</Text>}
                        {changeAmt < 0 && <Text style={localStyles.payRemainingText}>{t.remaining}: {Math.abs(changeAmt).toFixed(3)}</Text>}
                      </View>
                    );
                  })()}

                  <TouchableOpacity
                    style={[localStyles.payConfirmBtn, paying && { opacity: 0.7 }]}
                    onPress={onPayConfirmPress}
                    disabled={paying || !selectedPayMethodId || (() => {
                      const selMethod = payMethods.find(m => m.id === selectedPayMethodId);
                      const isCashMethod = selMethod?.is_cash_count || String(selMethod?.name || '').toLowerCase().includes('cash');
                      return isCashMethod && paidNum < totalAmt;
                    })()}
                    activeOpacity={0.85}
                  >
                    {paying ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={localStyles.payConfirmText}>{t.pay} - {formatCurrency(totalAmt)}</Text>
                    )}
                  </TouchableOpacity>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* ── Discount Modal ─────────────────────────────────────── */}
      <Modal visible={discountModalVisible} transparent animationType="fade" onRequestClose={() => setDiscountModalVisible(false)}>
        <Pressable style={localStyles.discountOverlay} onPress={() => setDiscountModalVisible(false)}>
          <Pressable style={localStyles.discountCard} onPress={(e) => e.stopPropagation()}>
            <View style={localStyles.discountHeader}>
              <Text style={localStyles.discountTitle}>Item Options</Text>
              <TouchableOpacity onPress={() => setDiscountModalVisible(false)}>
                <Text style={localStyles.discountCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            {discountTargetItem && (
              <Text style={localStyles.discountProductName}>
                {discountTargetItem.name || discountTargetItem.product_name || 'Product'}
              </Text>
            )}

            {/* Notes Section */}
            <View style={localStyles.noteSection}>
              <Text style={localStyles.noteSectionTitle}>Notes</Text>
              <TextInput
                style={localStyles.noteInput}
                value={noteText}
                onChangeText={handleNoteChange}
                placeholder="Add note for this item..."
                placeholderTextColor="#bbb"
                multiline
                textAlignVertical="top"
              />
            </View>

            {/* Discount Section */}
            <Text style={localStyles.discountSectionTitle}>Discount</Text>
            <View style={localStyles.discountGrid}>
              {DISCOUNT_OPTIONS.map(pct => (
                <TouchableOpacity
                  key={pct}
                  style={[localStyles.discountOption, discountTargetItem?.discount_percent === pct && localStyles.discountOptionActive]}
                  onPress={() => handleApplyDiscount(pct)}
                  activeOpacity={0.7}
                >
                  <Text style={[localStyles.discountOptionText, discountTargetItem?.discount_percent === pct && localStyles.discountOptionTextActive]}>{pct}%</Text>
                </TouchableOpacity>
              ))}
            </View>

            {discountTargetItem?.discount_percent > 0 && (
              <TouchableOpacity style={localStyles.discountRemoveBtn} onPress={handleRemoveDiscount} activeOpacity={0.7}>
                <Text style={localStyles.discountRemoveBtnText}>Remove Discount</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={localStyles.discountCancelBtn} onPress={() => setDiscountModalVisible(false)}>
              <Text style={localStyles.discountCancelText}>{t.cancel}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* KOT Wizard Step 1: Order Name */}
      <Modal visible={kotWizardStep === 'name'} transparent animationType="fade" onRequestClose={() => setKotWizardStep(null)}>
        <View style={kotStyles.overlay}>
          <View style={kotStyles.box}>
            <View style={kotStyles.titleRow}>
              <Text style={kotStyles.title}>Edit Order Name</Text>
              <TouchableOpacity onPress={() => setKotWizardStep(null)}><Text style={kotStyles.closeX}>✕</Text></TouchableOpacity>
            </View>
            <TextInput
              style={kotStyles.input}
              placeholder="e.g. John"
              placeholderTextColor="#aaa"
              value={kotCustomerName}
              onChangeText={setKotCustomerName}
              autoFocus
            />
            {kotRecentNames.length > 0 && (
              <View style={kotStyles.recentRow}>
                {kotRecentNames.map((n, i) => (
                  <TouchableOpacity key={i} style={kotStyles.recentChip} onPress={() => setKotCustomerName(n)}>
                    <Text style={kotStyles.recentChipText}>{n}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={kotStyles.btnRow}>
              <TouchableOpacity style={kotStyles.applyBtn} onPress={onKotNameNext}>
                <Text style={kotStyles.applyBtnText}>Apply</Text>
              </TouchableOpacity>
              <TouchableOpacity style={kotStyles.discardBtn} onPress={() => setKotWizardStep(null)}>
                <Text style={kotStyles.discardBtnText}>Discard</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* KOT Wizard Step 2: Date + Time Slot */}
      <Modal visible={kotWizardStep === 'time'} transparent animationType="fade" onRequestClose={() => setKotWizardStep(null)}>
        <View style={kotStyles.overlay}>
          <View style={kotStyles.box}>
            <View style={kotStyles.titleRow}>
              <Text style={kotStyles.title}>Select Date & Time</Text>
              <TouchableOpacity onPress={() => setKotWizardStep(null)}><Text style={kotStyles.closeX}>✕</Text></TouchableOpacity>
            </View>
            {/* Date chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {kotAvailableDates.map((d, i) => {
                const label = _kotFormatDateLabel(d);
                const active = kotSelectedDate && kotSelectedDate.toDateString() === d.toDateString();
                return (
                  <TouchableOpacity key={i} style={[kotStyles.dateChip, active && kotStyles.dateChipActive]} onPress={() => { setKotSelectedDate(d); setKotSelectedTime(null); }}>
                    <Text style={[kotStyles.dateChipText, active && kotStyles.dateChipTextActive]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {/* Time slots */}
            {kotTimeGroups.length > 0 ? (
              <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
                {kotTimeGroups.map(group => (
                  <View key={group.label} style={{ marginBottom: 10 }}>
                    <Text style={kotStyles.groupLabel}>{group.label}</Text>
                    <View style={kotStyles.slotsRow}>
                      {group.slots.map(slot => {
                        const active = kotSelectedTime === slot;
                        return (
                          <TouchableOpacity key={slot} style={[kotStyles.timeChip, active && kotStyles.timeChipActive]} onPress={() => setKotSelectedTime(active ? null : slot)}>
                            <Text style={[kotStyles.timeChipText, active && kotStyles.timeChipTextActive]}>{slot}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <View style={{ backgroundColor: '#fff8e1', borderRadius: 10, padding: 14, marginVertical: 12 }}>
                <Text style={{ color: '#b8860b', fontSize: 14, fontWeight: '600', textAlign: 'center' }}>No slot available for this day</Text>
              </View>
            )}
            <TouchableOpacity style={kotStyles.confirmBtn} onPress={onKotTimeConfirm}>
              <Text style={kotStyles.confirmBtnText}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
};

const kotStyles = RNStyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  box: { width: '88%', backgroundColor: '#fff', borderRadius: 16, padding: 20 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 16, fontWeight: '800', color: '#111' },
  closeX: { fontSize: 18, color: '#6b7280', paddingHorizontal: 6 },
  input: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#111',
    marginBottom: 12,
  },
  recentRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  recentChip: {
    backgroundColor: '#f3f4f6', borderRadius: 16,
    paddingVertical: 6, paddingHorizontal: 12, marginRight: 8, marginBottom: 8,
  },
  recentChipText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  btnRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  applyBtn: {
    backgroundColor: '#2E294E', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 18, marginRight: 10,
  },
  applyBtnText: { color: '#fff', fontWeight: '800' },
  discardBtn: {
    backgroundColor: '#f3f4f6', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 18,
  },
  discardBtnText: { color: '#374151', fontWeight: '700' },
  dateChip: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 14, marginRight: 8,
    backgroundColor: '#fff',
  },
  dateChipActive: { backgroundColor: '#2E294E', borderColor: '#2E294E' },
  dateChipText: { fontSize: 13, color: '#374151', fontWeight: '700' },
  dateChipTextActive: { color: '#fff' },
  groupLabel: { fontSize: 13, fontWeight: '700', color: '#6b7280', marginBottom: 6 },
  slotsRow: { flexDirection: 'row', flexWrap: 'wrap' },
  timeChip: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    paddingVertical: 6, paddingHorizontal: 12, marginRight: 8, marginBottom: 8,
    backgroundColor: '#fff',
  },
  timeChipActive: { backgroundColor: '#2E294E', borderColor: '#2E294E' },
  timeChipText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  timeChipTextActive: { color: '#fff' },
  confirmBtn: {
    backgroundColor: '#2E294E', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center', marginTop: 8,
  },
  confirmBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});

export default POSProducts;
