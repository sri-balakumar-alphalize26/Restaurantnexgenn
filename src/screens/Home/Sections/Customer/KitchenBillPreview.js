/**
 * KitchenBillPreview Screen
 *
 * Shows order items before sending KOT to kitchen.
 * Supports:
 *   - "Print Add-ons"  -> only NEW items since last print (delta)
 *   - "Print Full Order" -> all items
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  StatusBar,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import kotService from '../../../../api/services/kotService';
import { updatePosOrderFields } from '../../../../api/services/generalApi';
import useTranslation from '../../../../hooks/useTranslation';

// ── Snapshot store (tracks what was already printed) ───────────
const _snapshots = {};

function getSnapshot(key) {
  return _snapshots[key] || [];
}

function setSnapshot(key, items) {
  _snapshots[key] = items.map((it) => ({
    id: it.id,
    name: it.name || (Array.isArray(it.product_id) ? it.product_id[1] : 'Item'),
    qty: Number(it.quantity ?? it.qty ?? 1),
  }));
}

function getDelta(key, currentItems) {
  const prev = getSnapshot(key);
  if (!prev.length) return currentItems;

  const prevMap = {};
  prev.forEach((it) => {
    const k = String(it.id ?? it.name);
    prevMap[k] = (prevMap[k] || 0) + it.qty;
  });

  const delta = [];
  currentItems.forEach((it) => {
    const k = String(it.id ?? it.name);
    const curQty = Number(it.quantity ?? it.qty ?? 1);
    const prevQty = prevMap[k] || 0;
    const diff = curQty - prevQty;
    if (diff > 0) {
      delta.push({ ...it, qty: diff, quantity: diff });
    }
  });
  return delta;
}

// ── Component ──────────────────────────────────────────────────

const KitchenBillPreview = ({ navigation, route }) => {
  const { t } = useTranslation();
  const {
    items = [],
    orderId,
    orderName = '',
    tableName = '',
    serverName = '',
    order_type = null,
    guest_count = 0,
    customerName = '',
    scheduledDate = '',
    scheduledTime = '',
  } = route?.params || {};

  console.log('[KitchenBillPreview] mounted — customerName=', customerName, 'scheduledDate=', scheduledDate, 'scheduledTime=', scheduledTime, 'tableName=', tableName, 'orderName=', orderName);

  const [printingMode, setPrintingMode] = useState(null);
  const [userName, setUserName] = useState(serverName);

  // ── Resolve logged-in user name ──────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('userData');
        const ud = raw ? JSON.parse(raw) : null;
        const name =
          ud?.related_profile?.name || ud?.user_name || ud?.name || serverName || '';
        if (name) setUserName(name);
      } catch (e) {
        console.warn('[KOT] setup error:', e.message);
      }
    })();
  }, []);

  // ── Save customer name & time slot to Odoo (fallback — primary save is in POSProducts.onKotTimeConfirm)
  useEffect(() => {
    if (!orderId) return;
    const fields = {};
    if (customerName) {
      fields.floating_order_name = customerName;
    }
    if (scheduledDate) {
      const parts = scheduledDate.split('/');
      if (parts.length === 3) {
        const dateStr = `${parts[2]}-${parts[0]}-${parts[1]}`;
        fields.shipping_date = dateStr;
        if (scheduledTime) {
          fields.preset_time = `${dateStr} ${scheduledTime}:00`;
        }
      }
    }
    if (Object.keys(fields).length > 0) {
      updatePosOrderFields(orderId, fields).catch(() => {});
    }
  }, [orderId, customerName, scheduledDate, scheduledTime]);

  // ── Save initial snapshot for takeaway orders ────────────────
  const snapshotKey = orderId || orderName || null;

  useEffect(() => {
    const isTakeawayCheck =
      String(order_type || '').toUpperCase() === 'TAKEAWAY' ||
      String(order_type || '').toUpperCase() === 'TAKEOUT';

    if (isTakeawayCheck && snapshotKey && !getSnapshot(snapshotKey).length && items.length) {
      setSnapshot(snapshotKey, items);
    }
  }, [orderId, orderName, order_type, items.length]);

  // ── Map items to display format ──────────────────────────────
  const mapped = useMemo(
    () =>
      items.map((it) => ({
        id: String(it.id ?? it.name),
        name: it.name || (Array.isArray(it.product_id) ? it.product_id[1] : 'Item'),
        qty: Number(it.quantity ?? it.qty ?? 1),
        note: it.note || '',
      })),
    [items],
  );

  // ── Delta: items added since last print ──────────────────────
  const deltaItems = useMemo(() => {
    if (!snapshotKey) return mapped;
    const delta = getDelta(snapshotKey, items);
    return delta.map((it) => ({
      id: String(it.id ?? it.name),
      name: it.name || (Array.isArray(it.product_id) ? it.product_id[1] : 'Item'),
      qty: Number(it.quantity ?? it.qty ?? 1),
      note: it.note || '',
    }));
  }, [snapshotKey, items, mapped]);

  // ── Resolve order type label ─────────────────────────────────
  const isTakeaway =
    String(order_type || '').toUpperCase() === 'TAKEAWAY' ||
    String(order_type || '').toUpperCase() === 'TAKEOUT';

  const orderTypeLabel = isTakeaway
    ? t.takeout
    : order_type
      ? String(order_type).charAt(0).toUpperCase() + String(order_type).slice(1).toLowerCase()
      : t.dineIn;

  // ── Print handler ────────────────────────────────────────────
  const handlePrint = useCallback(
    async ({ deltaOnly = true } = {}) => {
      setPrintingMode(deltaOnly ? 'addons' : 'full');
      try {
        const printItems = deltaOnly
          ? (deltaItems.length ? deltaItems : mapped)
          : mapped;

        if (!printItems.length) {
          Alert.alert(t.addItem, t.nothingToPrint);
          return;
        }

        // Compute slot_time from wizard selection, or fall back to current date+time.
        // Forced fallback so the printed KOT always has a value even when the wizard is skipped.
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const nowDate = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
        const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const slotTime = (scheduledDate && scheduledTime)
          ? `${scheduledDate} ${scheduledTime}`
          : (scheduledTime
              ? `${nowDate} ${scheduledTime}`
              : (scheduledDate
                  ? `${scheduledDate} ${nowTime}`
                  : `${nowDate} ${nowTime}`));

        // Forced fallback for order_name — wizard value first, then Odoo order name, then table name, then 'Order'.
        const validOrderName = (v) => v && String(v).trim() && String(v).trim() !== '/';
        const orderNameOut = validOrderName(customerName)
          ? customerName.trim()
          : (validOrderName(orderName)
              ? orderName.trim()
              : (validOrderName(tableName) ? tableName.trim() : 'Order'));

        const kotData = {
          table_name: tableName,
          order_name: orderNameOut,
          order_id: orderId || null,
          cashier: userName,
          order_type: orderTypeLabel,
          guest_count: guest_count,
          print_type: deltaOnly ? 'ADDON' : 'NEW',
          slot_time: slotTime,
          items: printItems.map((it) => ({
            name: it.name,
            qty: it.qty,
            note: it.note || '',
          })),
        };

        const result = await kotService.printKot(kotData);

        if (snapshotKey) setSnapshot(snapshotKey, items);

        if (result && result.success !== false) {
          Alert.alert(t.kotPrinted, t.kotSentToPrinter);
        } else {
          const errMsg = result?.error || 'Failed to print KOT';
          if (errMsg.includes("doesn't exist") || errMsg.includes('does not exist')) {
            Alert.alert(t.moduleNotInstalled, t.kotModuleNotInstalled);
          } else {
            Alert.alert(t.printError, errMsg);
          }
        }
      } catch (e) {
        Alert.alert(t.printError, e.message || 'Failed to print KOT');
      } finally {
        setPrintingMode(null);
      }
    },
    [deltaItems, mapped, tableName, orderName, orderId, userName, orderTypeLabel, guest_count, snapshotKey, items, customerName, scheduledDate, scheduledTime],
  );

  // ── Render a single line item ────────────────────────────────
  const renderLine = (item, index) => (
    <View key={`${item.id}_${index}`} style={s.lineRow}>
      <View style={s.lineQtyBadge}>
        <Text style={s.lineQtyText}>{item.qty}</Text>
      </View>
      <View style={s.lineInfo}>
        <Text style={s.lineName}>{item.name}</Text>
        {item.note ? <Text style={s.lineNote}>{item.note}</Text> : null}
      </View>
    </View>
  );

  // ── UI ───────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Text style={s.backText}>{t.back}</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t.kitchenBillTitle}</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Order Info Card */}
        <View style={s.card}>
          <View style={s.cardHeader}>
            <View style={{ flex: 1 }}>
              <Text style={s.orderTitle}>
                {orderName && orderName !== '/' ? orderName : orderId ? `${t.order} #${orderId}` : t.order}
              </Text>
              {orderId && orderName && orderName !== '/' ? (
                <Text style={s.orderId}>#{orderId}</Text>
              ) : null}
            </View>
            {isTakeaway && (
              <View style={s.typeBadge}>
                <Text style={s.typeBadgeText}>{t.takeout}</Text>
              </View>
            )}
          </View>

          <View style={s.infoGrid}>
            {tableName ? (
              <View style={s.infoItem}>
                <Text style={s.infoLabel}>{t.table}</Text>
                <Text style={s.infoValue}>{tableName}</Text>
              </View>
            ) : null}
            {userName ? (
              <View style={s.infoItem}>
                <Text style={s.infoLabel}>{t.server}</Text>
                <Text style={s.infoValue}>{userName}</Text>
              </View>
            ) : null}
            <View style={s.infoItem}>
              <Text style={s.infoLabel}>{t.items}</Text>
              <Text style={s.infoValue}>{mapped.length}</Text>
            </View>
          </View>
        </View>

        {/* New / Add-on Items Section */}
        <View style={s.card}>
          <View style={s.sectionHeader}>
            <View style={[s.dot, { backgroundColor: '#F47B20' }]} />
            <Text style={s.sectionTitle}>{t.newItems}</Text>
            {deltaItems.length > 0 && (
              <View style={s.countBadge}>
                <Text style={s.countBadgeText}>{deltaItems.length}</Text>
              </View>
            )}
          </View>
          {deltaItems.length > 0 ? (
            deltaItems.map(renderLine)
          ) : (
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>{t.noNewItemsSincePrint}</Text>
            </View>
          )}
        </View>

        {/* Full Order Section */}
        <View style={s.card}>
          <View style={s.sectionHeader}>
            <View style={[s.dot, { backgroundColor: '#7c3aed' }]} />
            <Text style={s.sectionTitle}>{t.fullOrder}</Text>
            <View style={[s.countBadge, { backgroundColor: '#f3f0ff' }]}>
              <Text style={[s.countBadgeText, { color: '#7c3aed' }]}>{mapped.length}</Text>
            </View>
          </View>
          {mapped.map(renderLine)}
        </View>
      </ScrollView>

      {/* Bottom Action Buttons */}
      <View style={s.bottomBar}>
        <TouchableOpacity
          disabled={!!printingMode}
          onPress={() => handlePrint({ deltaOnly: true })}
          style={[s.primaryBtn, printingMode === 'addons' && { opacity: 0.7 }]}
          activeOpacity={0.85}
        >
          {printingMode === 'addons' ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={s.primaryBtnText}>{t.printAddons}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          disabled={!!printingMode}
          onPress={() => handlePrint({ deltaOnly: false })}
          style={[s.secondaryBtn, printingMode === 'full' && { opacity: 0.7 }]}
          activeOpacity={0.85}
        >
          {printingMode === 'full' ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={s.secondaryBtnText}>{t.printFullOrder}</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

export default KitchenBillPreview;

// ── Styles ─────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f0f2f8' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 16 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#2E294E',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  backBtn: { width: 60 },
  backText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 18,
    marginBottom: 14,
    ...Platform.select({
      ios: { shadowColor: '#1a1a2e', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 4 },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f8',
  },
  orderTitle: { fontSize: 18, fontWeight: '900', color: '#1a1a2e' },
  orderId: { fontSize: 12, color: '#8896ab', fontWeight: '600', marginTop: 2 },
  typeBadge: {
    backgroundColor: '#fff5eb',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#F47B2040',
  },
  typeBadgeText: { fontSize: 12, fontWeight: '800', color: '#F47B20' },

  infoGrid: { flexDirection: 'row', gap: 12 },
  infoItem: {
    flex: 1,
    backgroundColor: '#f8f9fc',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
  },
  infoLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8896ab',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  infoValue: { fontSize: 14, fontWeight: '800', color: '#1a1a2e' },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f8',
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  sectionTitle: { fontWeight: '800', fontSize: 16, color: '#1a1a2e', flex: 1 },
  countBadge: {
    backgroundColor: '#fff5eb',
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  countBadgeText: { fontSize: 13, fontWeight: '800', color: '#F47B20' },
  emptyWrap: { paddingVertical: 20, alignItems: 'center' },
  emptyText: { color: '#8896ab', fontWeight: '600', fontSize: 13 },

  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f8f9fc',
  },
  lineQtyBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#f0f2f8',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  lineQtyText: { fontSize: 14, fontWeight: '900', color: '#1a1a2e' },
  lineInfo: { flex: 1 },
  lineName: { fontSize: 14, fontWeight: '700', color: '#1a1a2e' },
  lineNote: { color: '#8896ab', fontSize: 12, marginTop: 2 },

  bottomBar: {
    padding: 16,
    paddingBottom: 16,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    ...Platform.select({
      ios: { shadowColor: '#1a1a2e', shadowOpacity: 0.1, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
      android: { elevation: 12 },
    }),
  },
  primaryBtn: {
    backgroundColor: '#7c3aed',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  secondaryBtn: {
    backgroundColor: '#F47B20',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
