import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { installPushHandlers } from '@/lib/push';
import { colors } from '@/lib/theme';
import { AuthProvider } from '@/state/auth';

// Must run at module load, not inside a component: the background message
// handler has to exist before a notification arrives while the app is closed.
installPushHandlers();

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerTitleStyle: { color: colors.text, fontWeight: '700' },
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          <Stack.Screen name="passenger/index" options={{ title: 'Request a ride' }} />
          <Stack.Screen name="passenger/ride/[rideId]" options={{ title: 'Your ride' }} />
          <Stack.Screen name="driver/index" options={{ title: 'Driver' }} />
          <Stack.Screen name="driver/ride/[rideId]" options={{ title: 'Pricing' }} />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
