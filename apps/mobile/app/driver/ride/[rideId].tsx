import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { OfferCard } from '@/components/OfferCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StatusPill } from '@/components/StatusPill';
import { formatMoney } from '@/lib/format';
import { colors, font, radius, spacing } from '@/lib/theme';
import { useCurrentLocation } from '@/lib/use-current-location';
import { useAuth } from '@/state/auth';
import { useRideRoom } from '@/state/use-ride-room';

/** How often we push our position to the ride room while on a job. */
const LOCATION_MS = 5_000;

export default function DriverRideScreen() {
  const params = useLocalSearchParams<{ rideId: string }>();
  const rideId = Array.isArray(params.rideId) ? params.rideId[0] : params.rideId;
  const { user, token } = useAuth();
  const { coords } = useCurrentLocation();

  const room = useRideRoom(rideId, token);
  const { ride, publishLocation } = room;

  const [price, setPrice] = useState('');
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState('');

  const coordsRef = useRef(coords);
  coordsRef.current = coords;

  const isAssignedDriver = Boolean(ride && user && ride.driverId === user.id);
  const negotiable = ride?.status === 'requested' || ride?.status === 'negotiating';
  const currency = ride?.currency ?? 'USD';

  const sortedOffers = useMemo(
    () => [...room.offers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [room.offers],
  );

  // Once we own the ride, stream our position into the room so the passenger's
  // map moves. The Durable Object throttles the durable write for us.
  useEffect(() => {
    if (!isAssignedDriver || !ride) return;
    const active = ['accepted', 'arrived', 'started'].includes(ride.status);
    if (!active) return;

    const publish = () => {
      const current = coordsRef.current;
      if (current) publishLocation(current.lat, current.lng);
    };
    publish();
    const timer = setInterval(publish, LOCATION_MS);
    return () => clearInterval(timer);
  }, [isAssignedDriver, ride?.status, publishLocation]);

  if (!user) return null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          {ride ? <StatusPill status={ride.status} /> : <Text style={styles.muted}>Loading ride…</Text>}
          <Text style={styles.connection}>{room.connection === 'open' ? 'Live' : room.connection}</Text>
        </View>

        {ride ? (
          <View style={styles.card}>
            <Text style={styles.caption}>Passenger offered</Text>
            <Text style={styles.bigPrice}>{formatMoney(ride.passengerProposedPrice, currency)}</Text>
            {ride.finalPrice ? <Text style={styles.muted}>Agreed at {formatMoney(ride.finalPrice, currency)}</Text> : null}
            <View style={styles.divider} />
            <Text style={styles.detail}>Pickup: {ride.pickup.address ?? `${ride.pickup.lat.toFixed(4)}, ${ride.pickup.lng.toFixed(4)}`}</Text>
            <Text style={styles.detail}>Dropoff: {ride.dropoff.address ?? `${ride.dropoff.lat.toFixed(4)}, ${ride.dropoff.lng.toFixed(4)}`}</Text>
          </View>
        ) : null}

        {room.error ? <Text style={styles.error}>{room.error}</Text> : null}

        {isAssignedDriver && ride ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitleInner}>Trip controls</Text>
            {ride.status === 'accepted' ? (
              <PrimaryButton label="I have arrived" onPress={() => room.transition('arrived')} />
            ) : null}
            {ride.status === 'arrived' ? (
              <PrimaryButton label="Start trip" onPress={() => room.transition('started')} />
            ) : null}
            {ride.status === 'started' ? (
              <PrimaryButton label="Complete trip" onPress={() => room.transition('completed')} />
            ) : null}
            {['completed', 'started'].includes(ride.status) ? null : (
              <PrimaryButton
                label="Cancel ride"
                variant="danger"
                onPress={() => room.transition('cancelled')}
                style={styles.topGap}
              />
            )}
          </View>
        ) : null}

        {negotiable ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitleInner}>Your counter-offer</Text>
            <TextInput
              style={styles.priceInput}
              value={price}
              onChangeText={setPrice}
              keyboardType="numbers-and-punctuation"
              placeholder="Price"
              placeholderTextColor={colors.textMuted}
            />
            <TextInput
              style={styles.messageInput}
              value={message}
              onChangeText={setMessage}
              placeholder="Optional note (e.g. 2 min away)"
              placeholderTextColor={colors.textMuted}
            />
            <PrimaryButton
              label="Send offer"
              onPress={() => {
                const value = Number(price);
                if (!Number.isFinite(value) || value <= 0) return;
                room.createOffer(value, message.trim() || undefined);
                setPrice('');
                setMessage('');
              }}
              style={styles.topGap}
            />
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Offers</Text>
        {sortedOffers.length === 0 ? (
          <Text style={styles.muted}>No offers yet.</Text>
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
          {room.messages.map((entry) => (
            <View key={entry.id} style={[styles.bubble, entry.userId === user.id ? styles.bubbleMine : null]}>
              <Text style={styles.bubbleText}>{entry.text}</Text>
            </View>
          ))}
        </View>
        <View style={styles.inline}>
          <TextInput
            style={styles.chatInput}
            value={chat}
            onChangeText={setChat}
            placeholder="Message the passenger"
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
  sectionTitleInner: { color: colors.text, fontSize: font.title, fontWeight: '700', marginBottom: spacing.md },
  priceInput: { height: 52, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, paddingHorizontal: spacing.md, color: colors.text, fontSize: font.title, marginBottom: spacing.sm },
  messageInput: { height: 48, backgroundColor: colors.surfaceRaised, borderRadius: radius.md, paddingHorizontal: spacing.md, color: colors.text, fontSize: font.body },
  topGap: { marginTop: spacing.md },
  error: { color: colors.danger, marginBottom: spacing.md },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  chatInput: { flex: 1, height: 52, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.md, color: colors.text, fontSize: font.body },
  sendButton: { width: 96 },
  chatLog: { marginBottom: spacing.md },
  bubble: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, alignSelf: 'flex-start', maxWidth: '85%' },
  bubbleMine: { backgroundColor: colors.primaryDark, alignSelf: 'flex-end' },
  bubbleText: { color: colors.text, fontSize: font.body },
});
