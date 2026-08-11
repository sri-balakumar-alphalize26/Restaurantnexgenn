import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from '@components/containers';
import { NavigationHeader } from '@components/Header';
import { Button } from '@components/common/Button';
import { useProductStore } from '@stores/product';
import Toast from 'react-native-toast-message';
import { createPosOrderOdoo, resolveTakeawayPresetId } from '@api/services/generalApi';
import { fetchPaymentJournalsOdoo, createAccountPaymentOdoo } from '@api/services/generalApi';
import { createPosPaymentOdoo } from '@api/services/generalApi';

const POS = ({ navigation, route }) => {
  const { customer } = route?.params || {};
  const { getCurrentCart, clearProducts } = useProductStore();
  const products = getCurrentCart();
  const [loading, setLoading] = useState(false);
  const [journals, setJournals] = useState([]);
  const [selectedJournal, setSelectedJournal] = useState(null);
  const [paying, setPaying] = useState(false);
  const [paymentMode, setPaymentMode] = useState(null); // 'cash' | 'card' | 'account'
  const [amountInput, setAmountInput] = useState(null);
  const [orderId, setOrderId] = useState(null);

  useEffect(() => {
    let mounted = true;
    const loadJournals = async () => {
      try {
        const list = await fetchPaymentJournalsOdoo();
        if (mounted) setJournals(list);
      } catch (e) {
      }
    };
    loadJournals();
    // after journals load, auto-create pos order
    (async () => {
      try {
        await loadJournals();
        await handleCreatePos();
      } catch (err) {
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleCreatePos = async () => {
    if (!products || products.length === 0) {
      Toast.show({ type: 'error', text1: 'Cart empty', text2: 'Add products before creating POS order', position: 'bottom' });
      return;
    }
    setLoading(true);
    try {
      const lines = products.map(p => ({ product_id: p.id, qty: p.quantity, price: p.price, name: p.name || p.product_name || '' }));
      const partnerId = customer?.id || customer?._id || null;
      const resp = await createPosOrderOdoo({ partnerId, lines, preset_id: (await resolveTakeawayPresetId()) || undefined });
      if (resp && resp.error) {
        const msg = typeof resp.error === 'string' ? resp.error : (resp.error.message || 'Failed to create POS order');
        Toast.show({ type: 'error', text1: 'POS Error', text2: msg, position: 'bottom' });
        setLoading(false);
        return;
      }
      const createdOrderId = resp && resp.result ? resp.result : null;
      if (!createdOrderId) {
        Toast.show({ type: 'error', text1: 'POS Error', text2: 'No order id returned', position: 'bottom' });
        setLoading(false);
        return;
      }
      setOrderId(createdOrderId);
      Toast.show({ type: 'success', text1: 'POS Order Created', text2: `Order ID: ${createdOrderId}`, position: 'bottom' });
      // Show payment UI so user can choose cash/card/account
      setPaymentMode('cash');
      setSelectedJournal(null);
    } catch (e) {
      Toast.show({ type: 'error', text1: 'POS Error', text2: e?.message || 'Failed to create POS order', position: 'bottom' });
    } finally {
      setLoading(false);
    }
  };

  const handleMakePosPayment = async () => {
    if (!orderId) {
      Toast.show({ type: 'error', text1: 'No Order', text2: 'POS order not created', position: 'bottom' });
      return;
    }
    if (!selectedJournal) {
      Toast.show({ type: 'error', text1: 'Select journal', text2: 'Please select a payment journal', position: 'bottom' });
      return;
    }
    setPaying(true);
    try {
      const amount = products.reduce((s, p) => s + ((p.price || 0) * (p.quantity || p.qty || 0)), 0);
      const partnerId = customer?.id || customer?._id || null;
      const payResp = await createPosPaymentOdoo({ orderId, amount, journalId: selectedJournal.id, partnerId });
      if (payResp && payResp.error) {
        const msg = payResp.error.message || JSON.stringify(payResp.error) || 'Payment error';
        Toast.show({ type: 'error', text1: 'Payment Error', text2: msg, position: 'bottom' });
      } else {
        Toast.show({ type: 'success', text1: 'Payment recorded', text2: 'Order marked as paid (POS)', position: 'bottom' });
        clearProducts();
        navigation.goBack();
      }
    } catch (e) {
      Toast.show({ type: 'error', text1: 'Payment Error', text2: e?.message || 'Failed to create payment', position: 'bottom' });
    } finally {
      setPaying(false);
    }
  };

  const computeTotal = () => {
    return products.reduce((s, p) => s + ((p.price || 0) * (p.quantity || p.qty || 0)), 0);
  };

  const handleAccountPayment = async () => {
    if (!selectedJournal) {
      Toast.show({ type: 'error', text1: 'Select journal', text2: 'Please select a payment journal', position: 'bottom' });
      return;
    }
    const total = computeTotal();
    setPaying(true);
    try {
      const partnerId = customer?.id || customer?._id || null;
      const res = await createAccountPaymentOdoo({ partnerId, journalId: selectedJournal.id, amount: total });
      if (res && res.error) {
        const msg = typeof res.error === 'string' ? res.error : (res.error.message || 'Payment failed');
        Toast.show({ type: 'error', text1: 'Payment Error', text2: msg, position: 'bottom' });
      } else if (res && res.result) {
        Toast.show({ type: 'success', text1: 'Payment recorded', text2: `Payment ID: ${res.result}`, position: 'bottom' });
        clearProducts();
        navigation.goBack();
      } else {
        Toast.show({ type: 'error', text1: 'Payment Error', text2: 'Unexpected response', position: 'bottom' });
      }
    } catch (e) {
      Toast.show({ type: 'error', text1: 'Payment Error', text2: e?.message || 'Failed to create payment', position: 'bottom' });
    } finally {
      setPaying(false);
    }
  };

  const filteredJournals = () => {
    if (!paymentMode) return journals;
    if (paymentMode === 'cash') return journals.filter(j => j.type === 'cash');
    if (paymentMode === 'card') return journals.filter(j => j.type === 'bank');
    return journals; // account: show all
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <NavigationHeader title="Point of Sale" onBackPress={() => navigation.goBack()} />
      <View style={{ padding: 20, flex: 1 }}>
        
        
        <View style={{ marginTop: 16 }}>
          <Text style={styles.sectionTitle}>Order Summary</Text>
          <View style={styles.card}>
            {products && products.length > 0 ? (
              <ScrollView style={{ maxHeight: 260 }}>
                {products.map(p => (
                  <View key={p.id} style={styles.lineItem}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.productName}>{p.name || p.product_name}</Text>
                      <Text style={styles.productMeta}>{(p.quantity || p.qty || 0)} × {(p.price || 0).toFixed(3)}</Text>
                    </View>
                    <Text style={styles.lineTotal}>{((p.price || 0) * (p.quantity || p.qty || 0)).toFixed(3)}</Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.emptyText}>No products in cart</Text>
            )}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>{computeTotal().toFixed(3)}</Text>
            </View>

            <Text style={styles.customerText}>Customer: {customer?.name || '—'}</Text>

            <View style={styles.payButtonWrap}>
              {loading ? (
                <ActivityIndicator size="large" color="#444" />
              ) : (
                <Button title="Payment" onPress={() => navigation.navigate('POSPayment', { orderId, products, customer })} />
              )}
            </View>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
};

export default POS;

const styles = StyleSheet.create({
  sectionTitle: { marginTop: 8, fontWeight: '700', fontSize: 18, color: '#fff' },
  card: { marginTop: 8, backgroundColor: '#fff', borderRadius: 8, padding: 12, shadowColor: '#00000010', elevation: 2, borderWidth: 1, borderColor: '#f0f0f0' },
  lineItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderColor: '#f5f5f5' },
  productName: { fontWeight: '600', color: '#111' },
  productMeta: { color: '#666', marginTop: 4, fontSize: 12 },
  lineTotal: { marginLeft: 12, fontWeight: '600', color: '#111' },
  emptyText: { color: '#666', padding: 12 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, borderTopWidth: 1, borderColor: '#f0f0f0', paddingTop: 12 },
  totalLabel: { fontWeight: '700', fontSize: 16, color: '#111' },
  totalValue: { fontWeight: '700', fontSize: 18, color: '#111' },
  customerText: { marginTop: 8, color: '#111', fontSize: 16, fontWeight: '700' },
  payButtonWrap: { marginTop: 14 },
});
