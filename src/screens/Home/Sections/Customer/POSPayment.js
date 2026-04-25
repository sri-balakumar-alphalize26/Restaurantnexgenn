import React, { useState, useEffect, useRef } from 'react';
import { generateUUIDv4 } from '@utils/uuid';
import { View, Text, ActivityIndicator, TouchableOpacity, ScrollView, StyleSheet, Modal, FlatList } from 'react-native';
import { SafeAreaView } from '@components/containers';
import { COLORS } from '@constants/theme';
import { NavigationHeader } from '@components/Header';
import { Button } from '@components/common/Button';
import { fetchPaymentJournalsOdoo, createAccountPaymentOdoo, fetchPOSSessions } from '@api/services/generalApi';
import { createPosOrderOdoo, createPosPaymentOdoo } from '@api/services/generalApi';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import ODOO_BASE_URL from '@api/config/odooConfig';

// Helper to fetch all payment methods from Odoo
const fetchAllPaymentMethods = async () => {
  try {
    const response = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model: 'pos.payment.method',
        method: 'search_read',
        args: [[]],
        kwargs: { fields: ['id', 'name', 'journal_id', 'is_cash_count', 'receivable_account_id', 'split_transactions'], limit: 100 },
      },
    }, { headers: { 'Content-Type': 'application/json' } });
    const methods = response.data?.result || [];
    if (methods.length > 0) {
    } else {
    }
    return methods;
  } catch (e) {
    return [];
  }
};
  // Helper to fetch payment method id for a journal
  const fetchPaymentMethodId = async (journalId) => {
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
      const paymentMethodId = response.data?.result?.[0]?.id;
      if (paymentMethodId) {
      } else {
      }
      return paymentMethodId;
    } catch (e) {
      return null;
    }
  };
import { useProductStore } from '@stores/product';
import Toast from 'react-native-toast-message';
import { useTranslation } from '@hooks';

const POSPayment = ({ navigation, route }) => {
  const { t } = useTranslation();
    const [invoiceChecked, setInvoiceChecked] = useState(false);
  const {
    products = [],
    customer: initialCustomer,
    sessionId,
    registerName
  } = route?.params || {};
  const [customer, setCustomer] = useState(initialCustomer);
  const openCustomerSelector = () => {
    navigation.navigate('CustomerScreen', {
      selectMode: true,
      onSelect: (selected) => {
        setCustomer(selected);
      },
    });
  };
  const [journals, setJournals] = useState([]);
  const [paymentMode, setPaymentMode] = useState('cash');
    useEffect(() => {
      if (paymentMode === 'account') {
      }
    }, [paymentMode, journals]);
  const [selectedJournal, setSelectedJournal] = useState(null);
  const [paying, setPaying] = useState(false);
  const { clearProducts } = useProductStore();
  const [inputAmount, setInputAmount] = useState('');
  const orderUuidRef = useRef(null);

  // Map journals to Odoo-style payment modes (cash / card / customer account)
  const getJournalForMode = (mode) => {
    if (!journals || journals.length === 0) return null;
    const byName = (name) => journals.find(j => j.name && j.name.toLowerCase().includes(name));
    if (mode === 'cash') {
      // Always return journal id 13 for cash to match Odoo config
      return journals.find(j => j.id === 13) || journals.find(j => j.type === 'cash') || byName('cash') || journals.find(j => j.type === 'cashbox');
    }
    if (mode === 'card') {
      return journals.find(j => j.type === 'bank') || byName('card') || byName('visa') || byName('master');
    }
    if (mode === 'account') {
      // Prefer receivable/sale journals or ones with 'account' wording
      return journals.find(j => j.type === 'sale') || journals.find(j => j.type === 'receivable') || byName('account') || journals[0];
    }
    return null;
  };

  // When payment mode or journals change, automatically pick the corresponding journal
  useEffect(() => {
    const j = getJournalForMode(paymentMode);
    setSelectedJournal(j);
  }, [paymentMode, journals]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const list = await fetchPaymentJournalsOdoo();
        if (mounted) setJournals(list);
      } catch (e) {
      }
    };
    load();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
  }, []);

  const computeTotal = () => (products || []).reduce((s, p) => s + ((p.price || 0) * (p.quantity || p.qty || 0)), 0);
  const paidAmount = parseFloat(inputAmount) || 0;
  const total = computeTotal();
  const remaining = total - paidAmount;

  const handleKeypad = (val) => {
    if (val === 'C') return setInputAmount('');
    if (val === '⌫') return setInputAmount(inputAmount.slice(0, -1));
    if (val === '+10') return setInputAmount((parseFloat(inputAmount) || 0 + 10).toString());
    if (val === '+20') return setInputAmount((parseFloat(inputAmount) || 0 + 20).toString());
    if (val === '+50') return setInputAmount((parseFloat(inputAmount) || 0 + 50).toString());
    if (val === '+/-') {
      if (inputAmount.startsWith('-')) setInputAmount(inputAmount.slice(1));
      else setInputAmount('-' + inputAmount);
      return;
    }
    if (val === '.') {
      if (!inputAmount.includes('.')) setInputAmount(inputAmount + '.');
      return;
    }
    setInputAmount(inputAmount + val);
  };

  const keypadRows = [
    ['1', '2', '3', '+10'],
    ['4', '5', '6', '+20'],
    ['7', '8', '9', '+50'],
    ['+/-', '0', '.', '⌫'],
  ];

  const handlePay = async () => {
    try {
      // Build order lines
      const lines = products.map(p => ({
        product_id: p.id,
        qty: p.quantity,
        price: p.price,
        name: p.name || p.product_name || ''
      }));
      const partnerId = customer?.id || customer?._id || null;
      // Use companyId from session, user, or default to 1
      const companyId = 1; // Replace with dynamic value if available

      // Automatically fetch posConfigId from sessionId
      let posConfigId = route?.params?.posConfigId || null;
      if (!posConfigId && sessionId) {
        try {
          const sessionList = await fetchPOSSessions({ limit: 10, offset: 0, state: '', });
          const session = sessionList.find(s => s.id === sessionId);
          if (session && session.config_id) {
            // Odoo often returns many2one as [id, name]
            if (Array.isArray(session.config_id)) {
              posConfigId = session.config_id[0];
            } else {
              posConfigId = session.config_id;
            }
          } else {
            posConfigId = null;
          }
        } catch (e) {
        }
      }
      // Idempotency: reuse the same uuid across retries so duplicate POSTs
      // (e.g. network timeout + interceptor retry) resolve to the same order.
      if (!orderUuidRef.current) orderUuidRef.current = generateUUIDv4();
      const posOrderPayload = { partnerId, lines, sessionId, posConfigId, companyId, orderName: '/', clientUuid: orderUuidRef.current };
      const posOrderPayloadWithPreset = { ...posOrderPayload, preset_id: 10, order_type: route?.params?.order_type };
      const resp = await createPosOrderOdoo(posOrderPayloadWithPreset);
      if (resp && resp.error) {
        Toast.show({ type: 'error', text1: 'POS Error', text2: resp.error.message || JSON.stringify(resp.error) || 'Failed to create POS order', position: 'bottom' });
        return;
      }
      const createdOrderId = resp && resp.result ? resp.result : null;
      if (!createdOrderId) {
        Toast.show({ type: 'error', text1: 'POS Error', text2: 'No order id returned', position: 'bottom' });
        return;
      }
      // Order confirmed — next Pay Now tap starts a fresh idempotency key.
      orderUuidRef.current = null;

      // Create payment in Odoo for cash or card mode
      if ((paymentMode === 'cash' || paymentMode === 'card') && selectedJournal) {
        try {
          // Fetch payment method id for selected journal
          const paymentMethodId = await fetchPaymentMethodId(selectedJournal.id);
          if (!paymentMethodId) {
            Toast.show({ type: 'error', text1: 'Payment Error', text2: 'No payment method found for selected journal', position: 'bottom' });
            return;
          }
          const payments = [];
          if (paymentMode === 'cash') {
            // For cash, add received and change (if any)
            if (paidAmount > 0) {
              payments.push({
                amount: paidAmount,
                paymentMethodId,
                journalId: selectedJournal.id,
                paymentMode,
              });
            }
            if (remaining < 0) {
              payments.push({
                amount: remaining, // negative value for change
                paymentMethodId,
                journalId: selectedJournal.id,
                paymentMode,
              });
            }
          } else if (paymentMode === 'card') {
            // For card, always create payment entry for total in card, and change (if any) as negative entry in cash
            if (total > 0) {
              payments.push({
                amount: total,
                paymentMethodId,
                journalId: selectedJournal.id,
                paymentMode,
              });
            }
            if (remaining < 0) {
              // Find cash journal and payment method for change
              const cashJournal = journals.find(j => j.id === 13) || journals.find(j => j.type === 'cash');
              if (cashJournal) {
                const cashPaymentMethodId = await fetchPaymentMethodId(cashJournal.id);
                if (cashPaymentMethodId) {
                  payments.push({
                    amount: remaining, // negative value for change
                    paymentMethodId: cashPaymentMethodId,
                    journalId: cashJournal.id,
                    paymentMode: 'cash',
                  });
                } else {
                }
              } else {
              }
            }
          }
          // Log each payment record for diagnostics
          payments.forEach((p, idx) => {
            const type = p.amount > 0 ? 'RECEIVED' : 'CHANGE';
          });
          const paymentPayload = {
            orderId: createdOrderId,
            payments,
            partnerId,
            sessionId,
            companyId
          };
          const paymentResp = await createPosPaymentOdoo(paymentPayload);
          if (paymentResp && paymentResp.error) {
            Toast.show({ type: 'error', text1: 'Payment Error', text2: paymentResp.error.message || JSON.stringify(paymentResp.error) || 'Failed to create payment', position: 'bottom' });
            // Optionally, you can return here or continue to receipt
          }
        } catch (e) {
          Toast.show({ type: 'error', text1: 'Payment Error', text2: e?.message || 'Failed to create payment', position: 'bottom' });
        }
      }

      // Proceed to receipt screen
      // If this was a TAKEAWAY order, clear the active takeaway marker
      try {
        if (String(route?.params?.order_type || '').toUpperCase() === 'TAKEAWAY') {
          await AsyncStorage.removeItem('active_takeaway_order');
        }
      } catch (e) { console.warn('Failed to clear active_takeaway_order', e); }
      navigation.navigate('POSReceiptScreen', {
        orderId: createdOrderId,
        products,
        customer,
        amount: paidAmount,
        invoiceChecked,
        sessionId,
        registerName
      });
    } catch (e) {
      Toast.show({ type: 'error', text1: 'POS Error', text2: e?.message || 'Failed to create POS order', position: 'bottom' });
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.white }}>
      <NavigationHeader title={t.payment} onBackPress={() => navigation.goBack()} />
      <View style={{ flex: 1, padding: 0, backgroundColor: COLORS.white }}>
        {/* Journal info removed — mapping remains internal */}
        {/* Large Amount Display */}
        <View style={{ alignItems: 'center', marginTop: 32, marginBottom: 12 }}>
          <Text style={{ fontSize: 60, fontWeight: 'bold', color: '#222' }}>{computeTotal().toFixed(3)} ج.ع.</Text>
        </View>

        {/* Payment Mode Cards */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', marginBottom: 18 }}>
          <TouchableOpacity onPress={async () => {
            setPaymentMode('cash');
            // Always use journal id 13 for cash
            const cashJournal = { id: 13, name: 'Cash Restaurant', type: 'cash' };
            setSelectedJournal(cashJournal);
            setTimeout(async () => {
              // Fetch and log full payment method details for journal id 9
              try {
                const response = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
                  jsonrpc: '2.0',
                  method: 'call',
                  params: {
                    model: 'pos.payment.method',
                    method: 'search_read',
                    args: [[['journal_id', '=', cashJournal.id]]],
                    kwargs: { fields: ['id', 'name', 'journal_id', 'is_cash_count', 'receivable_account_id', 'split_transactions'], limit: 10 },
                  },
                }, { headers: { 'Content-Type': 'application/json' } });
                const methods = response.data?.result || [];
                if (methods.length > 0) {
                } else {
                }
                  // Also fetch and log all payment methods for diagnostics
                  await fetchAllPaymentMethods();
              } catch (e) {
              }
            }, 100);
          }} style={[styles.modeCard, paymentMode === 'cash' && styles.modeCardSelected]}>
            <Text style={styles.modeCardIcon}>💵</Text>
            <Text style={[styles.modeCardText, paymentMode === 'cash' && styles.modeCardTextSelected]}>{t.cash}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={async () => {
            setPaymentMode('card');
            // Always use journal id 6 for card
            const cardJournal = journals.find(j => j.id === 6) || journals.find(j => j.type === 'bank');
            setSelectedJournal(cardJournal);
            setTimeout(async () => {
              if (cardJournal) {
                const paymentMethodId = await fetchPaymentMethodId(cardJournal.id);
                // This will log: Fetched payment_method_id for journal ...
              } else {
              }
            }, 100);
          }} style={[styles.modeCard, paymentMode === 'card' && styles.modeCardSelected]}>
              <Text style={styles.modeCardIcon}>💳</Text>
              <Text style={[styles.modeCardText, paymentMode === 'card' && styles.modeCardTextSelected]}>{t.card}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                setPaymentMode('card');
                setTimeout(async () => {
                  if (selectedJournal) {
                    try {
                      const response = await axios.post(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
                        jsonrpc: '2.0',
                        method: 'call',
                        params: {
                          model: 'pos.payment.method',
                          method: 'search_read',
                          args: [[['journal_id', '=', selectedJournal.id]]],
                          kwargs: { fields: ['id', 'name', 'journal_id', 'is_cash_count', 'receivable_account_id', 'split_transactions'], limit: 10 },
                        },
                      }, { headers: { 'Content-Type': 'application/json' } });
                      const methods = response.data?.result || [];
                      if (methods.length > 0) {
                      } else {
                      }
                      await fetchAllPaymentMethods();
                    } catch (e) {
                    }
                  } else {
                  }
                }, 100);
              }}
              style={{ display: 'none' }}
            />
          <TouchableOpacity onPress={async () => {
            setPaymentMode('account');
            setTimeout(async () => {
              if (selectedJournal) {
                await fetchPaymentMethodId(selectedJournal.id);
              } else {
              }
            }, 100);
          }} style={[styles.modeCard, paymentMode === 'account' && styles.modeCardSelected]}>
            <Text style={styles.modeCardIcon}>🏦</Text>
            <Text style={[styles.modeCardText, paymentMode === 'account' && styles.modeCardTextSelected]}>{t.customerAccount}</Text>
          </TouchableOpacity>
        </View>

        {/* Payment Input and Keypad */}
        <View style={{ alignItems: 'center', marginBottom: 18 }}>
          <View style={{
            width: '80%',
            backgroundColor: '#f6f8fa',
            borderRadius: 18,
            padding: 20,
            alignItems: 'center',
            marginBottom: 12,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.12,
            shadowRadius: 8,
            elevation: 4,
          }}>
            {paymentMode === 'account' ? (
              <>
                <Text style={{ color: '#2b6cb0', fontSize: 22, marginTop: 6 }}>{t.amountChargedToAccount}</Text>
                <Text style={{ color: '#2b6cb0', fontSize: 26, fontWeight: 'bold', marginBottom: 8 }}>{total.toFixed(3)} ج.ع.</Text>
              </>
            ) : (
              <>
                <Text style={{ fontSize: 26, color: '#222', marginBottom: 8, fontWeight: 'bold' }}>
                  {paymentMode === 'card' ? t.card : t.cash}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
                  <Text style={{ fontSize: 36, color: '#222', textAlign: 'center', flex: 1, fontWeight: 'bold' }}>{inputAmount || '0.000'} ج.ع.</Text>
                  {inputAmount ? (
                    <TouchableOpacity onPress={() => setInputAmount('')} style={{ marginLeft: 8 }}>
                      <Text style={{ fontSize: 28, color: '#c00', fontWeight: 'bold' }}>✕</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {remaining < 0 ? (
                  <>
                    <Text style={{ color: 'green', fontSize: 22, marginTop: 6 }}>{t.change}</Text>
                    <Text style={{ color: 'green', fontSize: 26, fontWeight: 'bold', marginBottom: 8 }}>{Math.abs(remaining).toFixed(3)} ج.ع.</Text>
                  </>
                ) : (
                  <>
                    <Text style={{ color: '#c00', fontSize: 22, marginTop: 6 }}>{t.remaining}</Text>
                    <Text style={{ color: '#c00', fontSize: 26, fontWeight: 'bold', marginBottom: 8 }}>{remaining.toFixed(3)} ج.ع.</Text>
                  </>
                )}
              </>
            )}
          </View>

          {/* Keypad */}
          <View style={{
            backgroundColor: '#f6f8fa',
            borderRadius: 18,
            padding: 18,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.10,
            shadowRadius: 6,
            elevation: 3,
            marginTop: 4,
          }}>
            {keypadRows.map((row, i) => (
              <View key={i} style={{ flexDirection: 'row', justifyContent: 'center', marginBottom: 12 }}>
                {row.map((key) => {
                  const isAction = key === 'C' || key === '⌫' || key.startsWith('+');
                  return (
                    <TouchableOpacity
                      key={key}
                      onPress={() => handleKeypad(key)}
                      style={{
                        width: 80,
                        height: 64,
                        backgroundColor: isAction ? '#2b6cb0' : '#fff',
                        borderRadius: 14,
                        marginHorizontal: 10,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        borderColor: isAction ? '#255a95' : '#eee',
                        shadowColor: isAction ? '#2b6cb0' : '#000',
                        shadowOffset: { width: 0, height: 1 },
                        shadowOpacity: isAction ? 0.18 : 0.08,
                        shadowRadius: 4,
                        elevation: isAction ? 2 : 1,
                      }}
                    >
                      <Text style={{ fontSize: 28, color: isAction ? '#fff' : '#222', fontWeight: key.startsWith('+') || isAction ? 'bold' : 'normal' }}>{key}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        </View>

        {/* Customer/Invoice/Validate */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 18, marginTop: 10 }}>
            <TouchableOpacity onPress={openCustomerSelector} style={{
              flex: 1,
              marginRight: 8,
              backgroundColor: '#f6f8fa',
              borderRadius: 16,
              paddingVertical: 24,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#eee',
              elevation: 2,
              flexDirection: 'column',
              justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 24, fontWeight: 'bold', color: '#222' }}>{t.customer}</Text>
              <Text style={{ fontSize: 22, color: '#444', marginTop: 4 }}>{customer?.name || t.select}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setInvoiceChecked(!invoiceChecked)}
              style={{
                flex: 1,
                marginLeft: 8,
                backgroundColor: '#f6f8fa',
                borderRadius: 16,
                paddingVertical: 24,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: '#eee',
                flexDirection: 'row',
                justifyContent: 'center',
                elevation: 2,
              }}
            >
              <View style={{ marginRight: 16 }}>
                <View style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  borderWidth: 3,
                  borderColor: invoiceChecked ? '#2b6cb0' : '#aaa',
                  backgroundColor: invoiceChecked ? '#2b6cb0' : '#fff',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  {invoiceChecked ? (
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: 'bold' }}>✓</Text>
                  ) : null}
                </View>
              </View>
              <View>
                <Text style={{ fontSize: 24, fontWeight: 'bold', color: '#222' }}>{t.invoice}</Text>
              </View>
            </TouchableOpacity>
          </View>
        <View style={{ alignItems: 'center', marginTop: 18 }}>
          <Button title={t.validate} onPress={handlePay} style={{ width: '90%', paddingVertical: 16, borderRadius: 10 }} textStyle={{ fontSize: 20 }} />
        </View>
      </View>
    </SafeAreaView>
  );
};

export default POSPayment;

const styles = StyleSheet.create({
  modeCard: { flex: 1, marginHorizontal: 6, backgroundColor: '#f6f8fa', borderRadius: 12, paddingVertical: 18, alignItems: 'center', borderWidth: 2, borderColor: '#eee', elevation: 2 },
  modeCardSelected: { backgroundColor: '#2b6cb0', borderColor: '#255a95' },
  modeCardIcon: { fontSize: 28, marginBottom: 8 },
  modeCardText: { color: '#222', fontWeight: '700', fontSize: 18 },
  modeCardTextSelected: { color: '#fff' },
});
