import type { Ride } from '@fairride/shared';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { StatusPill } from '@/components/StatusPill';
import { TextField } from '@/components/TextField';
import { ApiError, api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { colors, font, radius, spacing } from '@/lib/theme';
import { useCurrentLocation } from '@/lib/use-current-location';
import { useAuth } from '@/state/auth';

/** ~2 km north of the pickup, standing in for a real place picker. */
const DEMO_OFFSET_DEG = 0.018;

export default function PassengerHome() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { coords, permission, loading: locating, error: locationError, refresh } = useCurrentLocation();

  const [dropoffAddress, setDropoffAddress] = useState('');
  const [dropoffLat, setDropoffLat] = useState('');
  const [dropoffLng, setDropoffLng] = useState('');
  const [price, setPrice] = useState('12');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rides, setRides] = useState<Ride[]>([]);

  const loadRides = useCallback(async () => {
    try {
      const result = await api.listRides();
      setRides(result.rides);
    } catch {
      // A list failure should not block requesting a new ride.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadRides();
    }, [loadRides]),
  );

  function useDemoDestination() {
    if (!coords) return;
    setDropoffAddress((current) => current || 'Demo destination');
    setDropoffLat((coords.lat + DEMO_OFFSET_DEG).toFixed(5));
    setDropoffLng(coords.lng.toFixed(5));
  }

  async function requestRide() {
    setError(null);
    if (!coords) {
      setError('Waiting for your location. Tap "Retry location" if this persists.');
      return;
    }
    const lat = Number(dropoffLat);
    const lng = Number(dropoffLng);
    const proposedPrice = Number(price);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError('Enter a destination (or tap "Use demo destination").');
      return;
    }
    if (!Number.isFinite(proposedPrice) || proposedPrice <= 0) {
      setError('Enter the price you want to pay.');
      return;
    }

    setBusy(true);
    try {
      const { ride } = await api.createRide({
        pickup: { lat: coords.lat, lng: coords.lng, address: 'Current location' },
        dropoff: { lat, lng, address: dropoffAddress || null },
        proposedPrice,
        currency: 'USD',
      });
      router.push({ pathname: '/passenger/ride/[rideId]', params: { rideId: ride.id } });
      void loadRides();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not create the ride.');
    } finally {
      setBusy(false);
    }
  }

  const activeRides = rides.filter((ride) => ride.status !== 'completed' && ride.status !== 'cancelled');

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.greeting}>Hi{user?.fullName ? `, ${user.fullName}` : ''}</Text>
      <Text style={styles.caption}>Name your price and a nearby driver can take it.</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pickup</Text>
        <Text style={styles.location}>
          {coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : locating ? 'Locating…' : 'Location unavailable'}
        </Text>
        {permission === 'denied' || locationError ? (
          <PrimaryButton label="Retry location" variant="secondary" onPress={refresh} style={styles.smallTop} />
        ) : null}

        <View style={styles.divider} />

        <Text style={styles.cardTitle}>Destination</Text>
        <TextField label="Address label" value={dropoffAddress} onChangeText={setDropoffAddress} placeholder="Where to?" />
        <View style={styles.row}>
          <View style={styles.half}>
            <TextField label="Lat" value={dropoffLat} onChangeText={setDropoffLat} keyboardType="numbers-and-punctuation" autoCapitalize="none" />
          </View>
          <View style={styles.half}>
            <TextField label="Lng" value={dropoffLng} onChangeText={setDropoffLng} keyboardType="numbers-and-punctuation" autoCapitalize="none" />
          </View>
        </View>
        <PrimaryButton label="Use demo destination" variant="secondary" onPress={useDemoDestination} disabled={!coords} />

        <View style={styles.divider} />

        <Text style={styles.cardTitle}>Your price</Text>
        <View style={styles.priceRow}>
          <PrimaryButton label="−" variant="secondary" onPress={() => setPrice((p) => String(Math.max(1, Number(p) - 1)))} style={styles.stepper} />
          <Text style={styles.price}>{formatMoney(Number(price) || 0)}</Text>
          <PrimaryButton label="+" variant="secondary" onPress={() => setPrice((p) => String(Number(p) + 1))} style={styles.stepper} />
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <PrimaryButton label="Request ride" onPress={requestRide} loading={busy} disabled={!coords} />

      {activeRides.length > 0 ? (
        <View style={styles.activeBlock}>
          <Text style={styles.sectionTitle}>Active rides</Text>
          {activeRides.map((ride) => (
            <Pressable
              key={ride.id}
              style={styles.rideRow}
              onPress={() => router.push({ pathname: '/passenger/ride/[rideId]', params: { rideId: ride.id } })}
            >
              <View style={styles.flex}>
                <Text style={styles.rideTitle}>{formatMoney(ride.finalPrice ?? ride.passengerProposedPrice, ride.currency)}</Text>
                <Text style={styles.rideMeta}>{ride.dropoff.address ?? 'Destination'}</Text>
              </View>
              <StatusPill status={ride.status} />
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.spacer} />
      <PrimaryButton label="Sign out" variant="secondary" onPress={() => void signOut()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, paddingBottom: spacing.xxl },
  greeting: { color: colors.text, fontSize: font.display, fontWeight: '800' },
  caption: { color: colors.textMuted, fontSize: font.body, marginTop: spacing.xs, marginBottom: spacing.lg },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.textMuted, fontSize: font.small, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  location: { color: colors.text, fontSize: font.title, marginTop: spacing.xs },
  smallTop: { marginTop: spacing.md },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md },
  half: { flex: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  stepper: { width: 64 },
  price: { color: colors.text, fontSize: font.display, fontWeight: '800' },
  error: { color: colors.danger, marginTop: spacing.md },
  activeBlock: { marginTop: spacing.xl },
  sectionTitle: { color: colors.text, fontSize: font.title, fontWeight: '700', marginBottom: spacing.md },
  rideRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border },
  rideTitle: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  rideMeta: { color: colors.textMuted, fontSize: font.small, marginTop: 2 },
  spacer: { height: spacing.xl },
});
