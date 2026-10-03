import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '@/lib/theme';
import { useAuth } from '@/state/auth';

/**
 * The entry route decides where to send the user: sign in, driver console, or
 * passenger home. It renders nothing but a spinner until the persisted session
 * has been read, so the UI never flashes the wrong screen.
 */
export default function Index() {
  const { ready, user } = useAuth();

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!user) return <Redirect href="/sign-in" />;
  if (user.role === 'driver') return <Redirect href="/driver" />;
  return <Redirect href="/passenger" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
