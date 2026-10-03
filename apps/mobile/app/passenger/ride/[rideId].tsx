import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { OfferCard } from '@/components/OfferCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StatusPill } from '@/components/StatusPill';
import { ApiError, api } from '@/lib/api';
import { formatClock, formatMoney, statusLabel } from '@/lib/format';
import { colors, font, radius, spacing } from '@/lib/theme';
import { useAuth } from '@/state/auth';
import { useRideRoom } from '@/state/use-ride-room';

export default function PassengerRideScreen() {
  const params = useLocalSearchParams<{ rideId: string }>();
  const rideId = Array.isArray(params.rideId) ? params.rideId[0] : params.rideId;
  const { user, token } = useAuth();

  const room = useRideRoom(rideId, token);
  const { ride } = room;

  const [price, setPrice] = useState('');
  const [chat, setChat] = useState('');
  const [rating, setRating] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const negotiable = ride?.status === 'requested' || ride?.status === 'negotiating';
  const currency = ride?.currency ?? 'USD';

  const sortedOffers = useMemo(
    () => [...room.offers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [room.offers],
  );

  if (!user) return null;

  async function submitRating(score: number) {
    if (!rideId) return;
    setRating(score);
    try {
      await api.rateRide(rideId, { score });
      setNotice('Thanks for rating your driver.');
    } catch (cause) {
      setNotice(cause instanceof ApiError ? cause.message : 'Could not submit your rating.');
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          {ride ? <StatusPill status={ride.status} /> : <Text style={styles.muted}>Loading ride…</Text>}
          <Text style={styles.connection}>
            {room.connection === 'open' ? 'Live' : room.connection}
          </Text>
        </View>

        {ride ? (
          <View style={styles.card}>
            <Text style={styles.caption}>You pay your price</Text>
            <Text style={styles.bigPrice}>{formatMoney(ride.finalPrice ?? ride.passengerProposedPrice, currency)}</Text>
            {ride.finalPrice ? <Text style={styles.muted}>Agreed with your driver</Text> : null}

            <View style={styles.divider} />
            <Text style={styles.detail}>Pickup: {ride.pickup.address ?? `${ride.pickup.lat.toFixed(4)}, ${ride.pickup.lng.toFixed(4)}`}</Text>
            <Text style={styles.detail}>Dropoff: {ride.dropoff.address ?? `${ride.dropoff.lat.toFixed(4)}, ${ride.dropoff.lng.toFixed(4)}`}</Text>
            {room.driverLocation ? (
              <Text style={styles.detail}>
                Driver at {room.driverLocation.lat.toFixed(4)}, {room.driverLocation.lng.toFixed(4)} · {formatClock(room.driverLocation.at)}
              </Text>
            ) : null}
          </View>
        ) : null}

        {room.error ? <Text style={styles.error}>{room.error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        {negotiable ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Your price</Text>
            <View style={styles.inline}>
              <TextInput
                style={styles.priceInput}
                value={price}
                onChangeText={setPrice}
                keyboardType="numbers-and-punctuation"
                placeholder={String(ride?.passengerProposedPrice ?? 12)}
                placeholderTextColor={colors.textMuted}
              />
              <PrimaryButton
                label="Send"
                onPress={() => {
                  const value = Number(price);
                  if (!Number.isFinite(value) || value <= 0) {
                    setNotice('Enter a valid price first.');
                    return;
                  }
                  room.createOffer(value);
                  setPrice('');
                }}
                style={styles.sendButton}
              />
            </View>
            <Text style={styles.hint}>Raising your price puts you in front of more drivers.</Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Offers</Text>
        {sortedOffers.length === 0 ? (
          <Text style={styles.muted}>No offers yet. Drivers are looking at your request.</Text>
        ) : (
          sortedOffers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              currentUserId={user.id}
              currency={currency}
              actionable={negotiable}
              onAccept={room.acceptOffer}
              onReject={room.rejectOffer}
            />
          ))
        )}

        <Text style={styles.sectionTitle}>Chat</Text>
        <View style={styles.chatLog}>
          {room.messages.length === 0 ? <Text style={styles.muted}>No messages yet.</Text> : null}
          {room.messages.map((message) => (
            <View key={message.id} style={[styles.bubble, message.userId === user.id ? styles.bubbleMine : null]}>
              <Text style={styles.bubbleText}>{message.text}</Text>
            </View>
          ))}
        </View>
        <View style={styles.inline}>
          <TextInput
            style={styles.chatInput}
            value={chat}
            onChangeText={setChat}
            placeholder="Message your driver"
            placeholderTextColor={colors.textMuted}
          />
          <PrimaryButton
            label="Send"
            onPress={() => {
              const text = chat.trim();
              if (!text) return;
              room.sendChat(text);
              setChat('');
            }}
            style={styles.sendButton}
          />
        </View>

        {ride && ride.status === 'completed' ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Rate your driver</Text>
            <View style={styles.stars}>
              {[1, 2, 3, 4, 5].map((score) => (
                <Text key={score} onPress={() => void submitRating(score)} style={[styles.star, score <= rating ? styles.starOn : null]}>
                  ★
                </Text>
              ))}
            </View>
          </View>
        ) : null}

        {ride && ['requested', 'negotiating', 'accepted', 'arrived'].includes(ride.status) ? (
          <PrimaryButton label={`Cancel ride (${statusLabel(ride.status)})`} variant="danger" onPress={() => room.transition('cancelled')} />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, paddingBottom: spacing.xxl },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  connection: { color: colors.textMuted, fontSize: font.small },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg },
  caption: { color: colors.textMuted, fontSize: font.small, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  bigPrice: { color: colors.text, fontSize: font.display, fontWeight: '800', marginTop: spacing.xs },
  muted: { color: colors.textMuted, fontSize: font.body },
  detail: { color: colors.text, fontSize: font.body, marginTop: spacing.xs },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  sectionTitle: { color: colors.text, fontSize: font.title, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.md },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  priceInput: { flex: 1, height: 52, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, paddingHorizontal: spacing.md, color: colors.text, fontSize: font.title },
  chatInput: { flex: 1, height: 52, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.md, color: colors.text, fontSize: font.body },
  sendButton: { width: 96 },
  hint: { color: colors.textMuted, fontSize: font.small, marginTop: spacing.sm },
  error: { color: colors.danger, marginBottom: spacing.md },
  notice: { color: colors.primary, marginBottom: spacing.md },
  chatLog: { marginBottom: spacing.md },
  bubble: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, alignSelf: 'flex-start', maxWidth: '85%' },
  bubbleMine: { backgroundColor: colors.primaryDark, alignSelf: 'flex-end' },
  bubbleText: { color: colors.text, fontSize: font.body },
  stars: { flexDirection: 'row', gap: spacing.sm },
  star: { color: colors.border, fontSize: 32 },
  starOn: { color: colors.warning },
});
