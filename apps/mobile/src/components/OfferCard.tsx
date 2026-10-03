import type { RideOffer } from '@fairride/shared';
import { StyleSheet, Text, View } from 'react-native';

import { formatClock, formatMoney } from '../lib/format';
import { colors, font, radius, spacing } from '../lib/theme';
import { PrimaryButton } from './PrimaryButton';

interface OfferCardProps {
  offer: RideOffer;
  currentUserId: string;
  currency: string;
  /** False once the ride is matched or the offer is no longer actionable. */
  actionable: boolean;
  onAccept: (offerId: string) => void;
  onReject: (offerId: string) => void;
}

const STATUS_NOTE: Record<RideOffer['status'], string> = {
  pending: 'Awaiting a reply',
  accepted: 'Accepted',
  rejected: 'Declined',
  superseded: 'Withdrawn',
};

export function OfferCard({ offer, currentUserId, currency, actionable, onAccept, onReject }: OfferCardProps) {
  const isMine = offer.fromUserId === currentUserId;
  const canRespond = actionable && offer.status === 'pending' && !isMine;

  return (
    <View style={[styles.card, isMine ? styles.mine : null]}>
      <View style={styles.header}>
        <Text style={styles.price}>{formatMoney(offer.price, currency)}</Text>
        <Text style={styles.meta}>
          {isMine ? 'Your offer' : offer.fromRole === 'passenger' ? 'Passenger offer' : 'Driver offer'} ·{' '}
          {formatClock(offer.createdAt)}
        </Text>
      </View>

      {offer.message ? <Text style={styles.message}>{offer.message}</Text> : null}

      <Text style={styles.status}>{STATUS_NOTE[offer.status]}</Text>

      {canRespond ? (
        <View style={styles.actions}>
          <PrimaryButton label="Decline" variant="secondary" onPress={() => onReject(offer.id)} style={styles.action} />
          <PrimaryButton label="Accept" onPress={() => onAccept(offer.id)} style={styles.action} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  mine: { borderColor: colors.primaryDark },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  price: { color: colors.text, fontSize: font.title, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: font.small },
  message: { color: colors.text, fontSize: font.body, marginTop: spacing.sm },
  status: { color: colors.textMuted, fontSize: font.small, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  action: { flex: 1 },
});
