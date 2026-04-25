import React from 'react';
import { View } from 'react-native';
import { SafeAreaView as RNSSafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '@constants/theme';
import { StatusBar } from 'expo-status-bar';

// Default to full safe-area on all four edges so action buttons / bottom bars
// never sit under the Android system nav bar (3-button or gesture nav) or the
// iOS home indicator. Screens that want full-bleed bottom can pass
// edges={['top','left','right']} explicitly.
const SafeAreaView = ({ children, backgroundColor = COLORS.primaryThemeColor, edges }) => {

  return (
    <RNSSafeAreaView
      style={{ flex: 1, backgroundColor: backgroundColor }}
      edges={edges || ['top', 'left', 'right', 'bottom']}
    >
      <StatusBar backgroundColor={backgroundColor}  style='auto' />
      {children}
    </RNSSafeAreaView>
  );
};

export default SafeAreaView;
