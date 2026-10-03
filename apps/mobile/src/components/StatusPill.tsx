import type { RideStatus } from '@fairride/shared';
import { StyleSheet, Text, View } from 'react-native';

import { statusLabel } from '../lib/format';
import { colors, font, radius, spacing } from '../lib/theme';

const STATUS_COLORS: Record<RideStatus, string> = {
  requested: colors.textMuted,
  negotiating: colors.warning,
  accepted: colors.primary,
  arrived: colors.primary,
  started: colors.primary,
  completed: colors.textMuted,
  cancelled: colors.danger,
};

export function StatusPill({ status }: { status: RideStatus }) {
  const tone = STATUS_COLORS[status];
  return (
    <View style={[styles.pill, { borderColor: tone }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={styles.text}>{statusLabel(status)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  text: { color: colors.text, fontSize: font.small, fontWeight: '600' },
});
