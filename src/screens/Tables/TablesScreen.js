import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Dimensions, ActivityIndicator, Animated, Platform, Image } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { fetchRestaurantTablesOdoo, fetchOpenOrdersByTable, createDraftPosOrderOdoo, fetchPosPresets, fetchOrders, fetchPosOrderById, fetchOrderLinesByIds, preloadAllProducts } from '@api/services/generalApi';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from '@components/containers';
import { NavigationHeader } from '@components/Header';
import { useTranslation } from '@hooks';

const { width: windowWidth, height: windowHeight } = Dimensions.get('window');

// Animated table card
const TableCard = React.memo(({ children, style }) => {
  const scale = useRef(new Animated.Value(0.92)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 8, tension: 120, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[style, { opacity, transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
});

const TablesScreen = ({ navigation, route }) => {
  const { t } = useTranslation();
  const [tables, setTables] = useState([]);
  const [floors, setFloors] = useState([]);
  const [selectedFloorId, setSelectedFloorId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tableLoading, setTableLoading] = useState({});
  const [globalLoading, setGlobalLoading] = useState(false);
  const [tablesWithOpenOrders, setTablesWithOpenOrders] = useState([]);

  const setTableLoadingState = (id, value) => setTableLoading(prev => ({ ...prev, [id]: value }));

  const refreshTablesWithOpenOrders = async () => {
    try {
      const allResp = await fetchOrders({ sessionId: route?.params?.sessionId, limit: 500 });
      if (allResp && allResp.result) {
        const CLOSED_STATES = ['done', 'cancel', 'paid', 'receipt', 'invoiced', 'posted'];
        const openOrders = allResp.result.filter(o => Array.isArray(o.table_id) && o.state && !CLOSED_STATES.includes(String(o.state)));
        const tableHasPositive = {};
        openOrders.forEach(o => {
          const tableArr = o.table_id;
          if (!Array.isArray(tableArr) || !tableArr[0]) return;
          const tableId = Number(tableArr[0]);
          const amt = Number(o.amount_total || 0);
          if (!tableHasPositive[tableId]) tableHasPositive[tableId] = false;
          if (amt > 0) tableHasPositive[tableId] = true;
        });
        const openTableIds = Object.keys(tableHasPositive).filter(tid => tableHasPositive[tid]).map(tid => Number(tid));
        setTablesWithOpenOrders(openTableIds);
      }
    } catch (err) {
      setTablesWithOpenOrders([]);
    }
  };

  const handleTablePress = async (table) => {
    setGlobalLoading(true);
    const tableId = table.id;
    // Preload products in background — don't wait
    preloadAllProducts().catch(() => {});
    // Refresh open-order indicators in background — don't wait
    refreshTablesWithOpenOrders().catch(() => {});
    try {
      setTableLoadingState(tableId, true);
      const existing = await fetchOpenOrdersByTable(tableId);
      if (existing && existing.result && existing.result.length > 0) {
        const order = existing.result[0];
        // Fetch order details + lines in parallel
        const orderResp = await fetchPosOrderById(order.id);
        const rec = orderResp && orderResp.result ? orderResp.result : null;
        const lineIds = rec && Array.isArray(rec.lines) ? rec.lines : [];
        let orderLines = [];
        if (lineIds.length > 0) {
          const linesResp = await fetchOrderLinesByIds(lineIds);
          if (linesResp && linesResp.result) orderLines = linesResp.result;
        }
        const presetRef = (rec && Array.isArray(rec.preset_id) && rec.preset_id[0])
          ? rec.preset_id
          : (Array.isArray(order.preset_id) ? order.preset_id : null);
        const presetDetail = Array.isArray(presetRef) && presetRef[0] ? { id: presetRef[0], name: presetRef[1] } : null;
        navigation.navigate('POSProducts', { ...route?.params, orderId: order.id, tableId, orderLines, preset: presetDetail, preset_id: presetRef });
      } else {
        // No existing order — create a new one
        const sessionId = route?.params?.sessionId;
        const userId = route?.params?.userId;
        // Resolved by name below — preset ids are per-database and get
        // renumbered by Odoo upgrades, so there is no safe hardcoded default.
        let preset_id = null;
        let preset = null;
        try {
          const presetsResp = await fetchPosPresets({ limit: 200 });
          if (presetsResp && presetsResp.result && Array.isArray(presetsResp.result) && presetsResp.result.length > 0) {
            const dine = presetsResp.result.find(p => String(p.name).toLowerCase().includes('dine'));
            const chosen = dine || presetsResp.result[0];
            preset_id = chosen.id;
            preset = { id: chosen.id, name: chosen.name };
          }
        } catch (pErr) {}
        const created = await createDraftPosOrderOdoo({ sessionId, userId, tableId, preset_id, order_type: route?.params?.order_type || 'DINEIN' });
        if (created && created.result) {
          navigation.navigate('POSProducts', { ...route?.params, orderId: created.result, tableId, preset, preset_id });
        } else {
          throw new Error('Failed to create order');
        }
      }
    } catch (err) {
      try { alert(t.couldNotOpenTable); } catch (e) {}
    } finally {
      setTableLoadingState(tableId, false);
      setGlobalLoading(false);
    }
  };

  const loadTables = useCallback(async () => {
    setLoading(true);
    const res = await fetchRestaurantTablesOdoo();
    if (res.result) {
      const t = res.result;
      setTables(t);
      const floorMap = {};
      t.forEach(item => {
        const f = item.floor_id;
        if (Array.isArray(f) && f.length >= 1) {
          const floorName = f[1] || String(f[0]);
          if (!floorName.toLowerCase().includes('my company')) {
            floorMap[f[0]] = floorName;
          }
        }
      });
      const floorList = Object.keys(floorMap).map(id => ({ id: Number(id), name: floorMap[id] }));
      if (floorList.length === 0) floorList.push({ id: 0, name: t.mainFloor });
      setFloors(floorList);
      setSelectedFloorId(prev => prev ?? floorList[0].id);
      await refreshTablesWithOpenOrders();
    }
    setLoading(false);
  }, []);

  // Refresh tables every time the screen comes into focus
  useFocusEffect(
    useCallback(() => {
      loadTables();
    }, [loadTables])
  );

  const floorTables = tables.filter(t => {
    const f = t.floor_id;
    if (!f) return selectedFloorId === 0 || selectedFloorId === null;
    return selectedFloorId === null ? true : Number(f[0]) === Number(selectedFloorId);
  });

  const openCount = floorTables.filter(t => tablesWithOpenOrders.includes(t.id)).length;
  const freeCount = floorTables.length - openCount;

  // Grid layout: 3 columns
  const COLS = 3;
  const GRID_PAD = 20;
  const GAP = 14;
  const cardW = Math.floor((windowWidth - GRID_PAD * 2 - GAP * (COLS - 1)) / COLS);

  return (
    <SafeAreaView style={s.container}>
      <NavigationHeader title={t.selectTable} onBackPress={() => navigation.goBack()} logo={false} />

      {/* Centered logo with glow */}
      <View style={s.logoWrap}>
        <View style={s.logoGlow} />
        <Image source={require('@assets/images/logo2.png')} style={s.logoImage} />
      </View>

      {/* Global loading overlay */}
      {globalLoading && (
        <View style={s.globalOverlay}>
          <View style={s.globalOverlayBox}>
            <ActivityIndicator size="large" color="#F47B20" />
            <Text style={s.globalOverlayText}>{t.openingTable}</Text>
          </View>
        </View>
      )}

      {loading ? (
        <View style={s.loaderWrap}>
          <ActivityIndicator size="large" color="#F47B20" />
          <Text style={s.loaderText}>{t.loadingTables}</Text>
        </View>
      ) : (
        <>
          {/* Floor tabs */}
          <View style={s.floorTabsWrap}>
            {floors.map(f => {
              const active = selectedFloorId === f.id;
              return (
                <TouchableOpacity
                  key={f.id}
                  style={[s.floorTab, active && s.floorTabActive]}
                  onPress={() => setSelectedFloorId(f.id)}
                  activeOpacity={0.8}
                >
                  <Text style={[s.floorTabText, active && s.floorTabTextActive]}>{f.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Stats row */}
          <View style={s.statsRow}>
            <View style={s.statItem}>
              <View style={[s.statDot, { backgroundColor: '#7c3aed' }]} />
              <Text style={s.statText}>{openCount} {t.occupied}</Text>
            </View>
            <View style={s.statItem}>
              <View style={[s.statDot, { backgroundColor: '#22c55e' }]} />
              <Text style={s.statText}>{freeCount} {t.available}</Text>
            </View>
            <View style={s.statItem}>
              <Text style={s.statTotal}>{floorTables.length} {t.total}</Text>
            </View>
          </View>

          {/* Table grid */}
          <ScrollView contentContainerStyle={s.gridContent} showsVerticalScrollIndicator={false}>
            <View style={s.grid}>
              {floorTables.map((table, idx) => {
                const label = table.table_number ? `T${table.table_number}` : `T${table.id}`;
                const seats = table.seats || 4;
                const isOpen = tablesWithOpenOrders.includes(table.id);
                const isLoading = tableLoading[table.id];

                return (
                  <TableCard key={table.id} style={{ width: cardW, marginBottom: GAP }}>
                    <TouchableOpacity
                      style={[s.tableCard, isOpen && s.tableCardOpen]}
                      onPress={() => handleTablePress(table)}
                      activeOpacity={0.85}
                      disabled={isLoading}
                    >
                      {isLoading && (
                        <View style={s.tableLoadingOverlay}>
                          <ActivityIndicator size="small" color="#fff" />
                        </View>
                      )}

                      {/* Table number */}
                      <Text style={[s.tableLabel, isOpen && s.tableLabelOpen]}>{label}</Text>

                      {/* Seats */}
                      <View style={[s.seatsBadge, isOpen && s.seatsBadgeOpen]}>
                        <Text style={s.seatsIcon}>🪑</Text>
                        <Text style={[s.seatsText, isOpen && s.seatsTextOpen]}>{seats}</Text>
                      </View>

                      {/* Status indicator */}
                      <View style={[s.statusBar, isOpen ? s.statusBarOpen : s.statusBarFree]} />
                    </TouchableOpacity>
                  </TableCard>
                );
              })}
            </View>
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
};

const CARD_RADIUS = 16;

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f2f8',
  },

  // Logo
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -30,
    marginBottom: -10,
  },
  logoGlow: {
    position: 'absolute',
    width: 280,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  logoImage: {
    width: 200,
    height: 200,
    resizeMode: 'contain',
  },

  // Loader
  loaderWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loaderText: {
    marginTop: 12,
    fontSize: 15,
    color: '#8896ab',
    fontWeight: '600',
  },

  // Global overlay
  globalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  globalOverlayBox: {
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingVertical: 30,
    paddingHorizontal: 40,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 20 },
    }),
  },
  globalOverlayText: {
    marginTop: 14,
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a2e',
  },

  // Floor tabs
  floorTabsWrap: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 20,
    marginBottom: 12,
    gap: 10,
  },
  floorTab: {
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 12,
    backgroundColor: '#fff',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 3 },
    }),
  },
  floorTabActive: {
    backgroundColor: '#7c3aed',
    ...Platform.select({
      ios: { shadowColor: '#7c3aed', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 6 },
    }),
  },
  floorTabText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#6b7a90',
  },
  floorTabTextActive: {
    color: '#fff',
  },

  // Stats row
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 16,
    gap: 20,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8896ab',
  },
  statTotal: {
    fontSize: 13,
    fontWeight: '800',
    color: '#1a1a2e',
  },

  // Grid
  gridContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },

  // Table card
  tableCard: {
    aspectRatio: 1,
    borderRadius: CARD_RADIUS,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#1a1a2e',
        shadowOpacity: 0.1,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 6 },
      },
      android: {
        elevation: 6,
      },
    }),
  },
  tableCardOpen: {
    backgroundColor: '#7c3aed',
    ...Platform.select({
      ios: {
        shadowColor: '#7c3aed',
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
      },
      android: {
        elevation: 10,
      },
    }),
  },

  tableLabel: {
    fontSize: 22,
    fontWeight: '900',
    color: '#1a1a2e',
    letterSpacing: 0.5,
  },
  tableLabelOpen: {
    color: '#fff',
  },

  // Seats badge
  seatsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    backgroundColor: '#f0f2f8',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 10,
    gap: 4,
  },
  seatsBadgeOpen: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  seatsIcon: {
    fontSize: 12,
  },
  seatsText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7a90',
  },
  seatsTextOpen: {
    color: '#fff',
  },

  // Bottom status bar
  statusBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
  },
  statusBarOpen: {
    backgroundColor: '#F47B20',
  },
  statusBarFree: {
    backgroundColor: '#22c55e',
  },

  // Table loading
  tableLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: CARD_RADIUS,
    zIndex: 10,
  },
});

export default TablesScreen;
