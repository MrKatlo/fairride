import type { DriverProfile } from '@/lib/api';
import type { Ride } from '@fairride/shared';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { TextField } from '@/components/TextField';
import { ApiError, api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { colors, font, radius, spacing } from '@/lib/theme';
import { useCurrentLocation } from '@/lib/use-current-location';
import { useAuth } from '@/state/auth';

/** How often an online driver reports its position to the API. */
const HEARTBEAT_MS = 15_000;

export default function DriverHome() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { coords, error: locationError } = useCurrentLocation();

  const [profile, setProfile] = useState<DriverProfile | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [rides, setRides] = useState<Ride[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Onboarding fields.
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [plate, setPlate] = useState('');
  const [license, setLicense] = useState('');

  const coordsRef = useRef(coords);
  coordsRef.current = coords;

  const loadProfile = useCallback(async () => {
    try {
      const { profile: loaded } = await api.getDriverProfile();
      setProfile(loaded);
      setNeedsOnboarding(false);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setNeedsOnboarding(true);
        return;
      }
      setError(cause instanceof ApiError ? cause.message : 'Could not load your driver profile.');
    }
  }, []);

  const loadRides = useCallback(async () => {
    try {
      const result = await api.availableRides();
      setRides(result.rides);
    } catch {
      // Discovery failing should not take the whole screen down.
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useFocusEffect(
    useCallback(() => {
      void loadRides();
      const timer = setInterval(() => void loadRides(), HEARTBEAT_MS);
      return () => clearInterval(timer);
    }, [loadRides]),
  );

  // While online, publish our location so passengers can see an accurate
  // distance and the server can filter open requests to our area.
  useEffect(() => {
    if (!profile?.isOnline) return;
    const publish = () => {
      const current = coordsRef.current;
      if (current) void api.updateDriverLocation(current.lat, current.lng).catch(() => undefined);
    };
    publish();
    const timer = setInterval(publish, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [profile?.isOnline]);

  async function onboard() {
    setBusy(true);
    setError(null);
    try {
      const { profile: created } = await api.onboardDriver({
        vehicleMake: make || undefined,
        vehicleModel: model || undefined,
        vehiclePlate: plate || undefined,
        licenseNumber: license || undefined,
      });
      setProfile(created);
      setNeedsOnboarding(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not save your details.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleOnline() {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await api.setDriverOnline(!profile.isOnline);
      await loadProfile();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not change your availability.');
    } finally {
      setBusy(false);
    }
  }

  if (needsOnboarding) {
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Set up your driver profile</Text>
        <Text style={styles.caption}>Add your vehicle and licence. An admin approves accounts before you can go online.</Text>
        <TextField label="Vehicle make" value={make} onChangeText={setMake} placeholder="Toyota" />
        <TextField label="Vehicle model" value={model} onChangeText={setModel} placeholder="Corolla" />
        <TextField label="Plate" value={plate} onChangeText={setPlate} placeholder="ABC-1234" autoCapitalize="characters" />
        <TextField label="Licence number" value={license} onChangeText={setLicense} placeholder="D1234567" autoCapitalize="characters" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton label="Create profile" onPress={onboard} loading={busy} />
        <View style={styles.spacer} />
        <PrimaryButton label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Availability</Text>
        <Text style={styles.caption}>
          {profile ? `Approval: ${profile.approvalStatus}` : 'Loading profile…'}
        </Text>
        {profile ? (
          <PrimaryButton
            label={profile.isOnline ? 'Go offline' : 'Go online'}
            variant={profile.isOnline ? 'danger' : 'primary'}
            onPress={toggleOnline}
            loading={busy}
            disabled={profile.approvalStatus !== 'approved'}
          />
        ) : null}
        {profile && profile.approvalStatus !== 'approved' ? (
          <Text style={styles.hint}>Your documents are still being reviewed.</Text>
        ) : null}
        {locationError ? <Text style={styles.hint}>{locationError}</Text> : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.sectionTitle}>Open requests</Text>
      {profile && !profile.isOnline ? (
        <Text style={styles.caption}>Go online to receive requests near you.</Text>
      ) : rides.length === 0 ? (
        <Text style={styles.caption}>No open requests right now. Pull down isn’t wired yet - this refreshes automatically.</Text>
      ) : (
        rides.map((ride) => (
          <Pressable
            key={ride.id}
            style={styles.rideRow}
            onPress={() => router.push({ pathname: '/driver/ride/[rideId]', params: { rideId: ride.id } })}
          >
            <View style={styles.flex}>
              <Text style={styles.ridePrice}>
                {formatMoney(ride.passengerProposedPrice, ride.currency)} offered
              </Text>
              <Text style={styles.rideMeta}>
                {ride.pickup.address ?? 'Pickup'} → {ride.dropoff.address ?? 'Destination'}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))
      )}

      <View style={styles.spacer} />
      <PrimaryButton label="Sign out" variant="secondary" onPress={() => void signOut()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, paddingBottom: spacing.xxl },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg },
  title: { color: colors.text, fontSize: font.title, fontWeight: '800' },
  caption: { color: colors.textMuted, fontSize: font.body, marginTop: spacing.xs, marginBottom: spacing.md },
  hint: { color: colors.warning, fontSize: font.small, marginTop: spacing.sm },
  error: { color: colors.danger, marginBottom: spacing.md },
  sectionTitle: { color: colors.text, fontSize: font.title, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.md },
  rideRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border },
  ridePrice: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  rideMeta: { color: colors.textMuted, fontSize: font.small, marginTop: 2 },
  chevron: { color: colors.textMuted, fontSize: 28 },
  spacer: { height: spacing.xl },
});
