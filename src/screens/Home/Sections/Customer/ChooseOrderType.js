import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Animated, Platform, Image, Dimensions } from 'react-native';

import { SafeAreaView } from '@components/containers';
import { NavigationHeader } from '@components/Header';
import { useTranslation } from '@hooks';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
import { createDraftPosOrderOdoo, fetchPosPresets } from '@api/services/generalApi';

// 3D Animated Card
const Card3D = ({ children, style, delay = 0 }) => {
  const scale = useRef(new Animated.Value(0.88)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(50)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 6, tension: 80, delay, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 400, delay, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, friction: 7, tension: 60, delay, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[style, { opacity, transform: [{ scale }, { translateY }, { perspective: 1000 }] }]}>
      {children}
    </Animated.View>
  );
};

const ChooseOrderType = ({ navigation, route }) => {
  const { t } = useTranslation();
  const params = route?.params || {};
  const [loading, setLoading] = useState(false);

  const goDineIn = () => {
    navigation.navigate('TablesScreen', { ...params, order_type: 'DINEIN' });
  };

  const goTakeaway = async () => {
    setLoading(true);
    try {
      // Resolve by name — preset ids differ per database and are renumbered by
      // Odoo upgrades, so there is no safe hardcoded id to fall back to.
      let preset_id = null;
      let preset = null;
      try {
        const resp = await fetchPosPresets({ limit: 200 });
        if (resp && resp.result && Array.isArray(resp.result) && resp.result.length > 0) {
          const take = resp.result.find(p => String(p.name).toLowerCase().includes('take'));
          const chosen = take || resp.result[0];
          preset_id = chosen.id;
          preset = { id: chosen.id, name: chosen.name };
        }
      } catch (e) {}
      console.log('[TAKEAWAY]', `new order: preset_id=${preset_id ?? '(none resolved)'}${preset ? ` "${preset.name}"` : ''}`);

      // Always create a brand-new draft order so the cart starts empty.
      const created = await createDraftPosOrderOdoo({
        sessionId: params.sessionId,
        userId: params.userId,
        tableId: false,
        preset_id,
        order_type: 'TAKEAWAY',
      });
      if (!created || created.error || !created.result) {
        throw new Error(created?.error?.data?.message || created?.error?.message || 'Failed to create takeaway order');
      }
      const newOrderId = created.result;

      navigation.navigate('POSProducts', {
        ...params,
        orderId: newOrderId,
        preset,
        preset_id,
        cartOwner: `order_${newOrderId}`,
        order_type: 'TAKEAWAY',
      });
    } catch (err) {
      console.error('goTakeaway error', err);
      Alert.alert(t.error, err?.message || t.failedToStartTakeaway);
    } finally {
      setLoading(false);
    }
  };

  const openTakeawayOrders = () => {
    navigation.navigate('TakeawayOrders', { ...params });
  };

  const CARDS = [
    {
      key: 'dine',
      title: t.dineIn,
      subtitle: t.dineInSubtitle,
      icon: '🍽️',
      accent: '#7c3aed',
      accentLight: '#f3f0ff',
      onPress: goDineIn,
    },
    {
      key: 'takeout',
      title: t.newTakeoutOrder,
      subtitle: t.newTakeoutSubtitle,
      icon: '🥡',
      accent: '#F47B20',
      accentLight: '#fff5eb',
      onPress: goTakeaway,
    },
    {
      key: 'orders',
      title: t.takeoutOrders,
      subtitle: t.takeoutOrdersSubtitle,
      icon: '📋',
      accent: '#16a34a',
      accentLight: '#f0fdf4',
      onPress: openTakeawayOrders,
    },
  ];

  return (
    <SafeAreaView style={s.container}>
      <NavigationHeader title={t.chooseOrderType} onBackPress={() => navigation.goBack()} logo={false} />

      {loading && (
        <View style={s.loadingOverlay}>
          <View style={s.loadingBox}>
            <ActivityIndicator size="large" color="#F47B20" />
            <Text style={s.loadingText}>{t.creatingOrder}</Text>
          </View>
        </View>
      )}

      <View style={s.content}>
        {/* Centered logo with glow */}
        <View style={s.logoWrap}>
          <View style={s.logoGlow} />
          <Image source={require('@assets/images/logo2.png')} style={s.logoImage} />
        </View>

        {/* Title */}
        <Text style={s.headerTitle}>{t.howToServe}</Text>

        {/* Cards */}
        <View style={s.cardsArea}>
          {CARDS.map((card, i) => (
            <Card3D key={card.key} style={s.card3d} delay={i * 120}>
              <TouchableOpacity
                style={[s.cardTouch, { borderLeftWidth: 5, borderLeftColor: card.accent }]}
                activeOpacity={0.85}
                onPress={card.onPress}
                disabled={loading}
              >
                <View style={s.cardBody}>
                  <View style={s.cardRow}>
                    {/* Icon circle */}
                    <View style={[s.iconCircle, { backgroundColor: card.accentLight, borderColor: card.accent + '40' }]}>
                      <Text style={s.iconEmoji}>{card.icon}</Text>
                    </View>
                    {/* Text */}
                    <View style={s.cardTextWrap}>
                      <Text style={s.cardTitle}>{card.title}</Text>
                      <Text style={s.cardSubtitle}>{card.subtitle}</Text>
                    </View>
                    {/* Arrow */}
                    <View style={[s.arrowCircle, { backgroundColor: card.accent }]}>
                      <Text style={s.arrowText}>›</Text>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            </Card3D>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
};

const CARD_RADIUS = 18;

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f2f8',
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 10,
  },

  // Logo
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  logoGlow: {
    position: 'absolute',
    width: 360,
    height: 170,
    borderRadius: 85,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  logoImage: {
    width: 280,
    height: 280,
    resizeMode: 'contain',
  },

  // Header
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 24,
    letterSpacing: 0.3,
  },

  // Cards
  cardsArea: {
    gap: 18,
  },
  card3d: {
    borderRadius: CARD_RADIUS,
    backgroundColor: '#fff',
    ...Platform.select({
      ios: {
        shadowColor: '#1a1a2e',
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 10 },
      },
      android: {
        elevation: 12,
      },
    }),
  },
  cardTouch: {
    borderRadius: CARD_RADIUS,
    overflow: 'hidden',
  },
  cardBody: {
    paddingVertical: 22,
    paddingHorizontal: 18,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconCircle: {
    width: 58,
    height: 58,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
  },
  iconEmoji: {
    fontSize: 28,
  },
  cardTextWrap: {
    flex: 1,
    marginLeft: 16,
  },
  cardTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#1a1a2e',
    letterSpacing: 0.3,
  },
  cardSubtitle: {
    fontSize: 13,
    color: '#8896ab',
    fontWeight: '500',
    marginTop: 3,
    lineHeight: 18,
  },
  arrowCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
  },
  arrowText: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '700',
    marginTop: -2,
  },

  // Loading overlay
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  loadingBox: {
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
  loadingText: {
    marginTop: 14,
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a2e',
  },
});

export default ChooseOrderType;
