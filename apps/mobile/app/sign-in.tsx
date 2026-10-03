import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { TextField } from '@/components/TextField';
import { ApiError, api } from '@/lib/api';
import { currentIdToken, describeAuthError, startPhoneSignIn, type PhoneConfirmation } from '@/lib/firebase';
import { registerForPush } from '@/lib/push';
import { colors, font, spacing } from '@/lib/theme';
import { useAuth } from '@/state/auth';

type Step = 'phone' | 'code';

/**
 * Two steps: Firebase sends and verifies the SMS, then we trade the resulting ID
 * token for our own session JWT. The phone number is never sent to our API -
 * it comes back inside the verified Firebase token.
 */
export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useAuth();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<PhoneConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await startPhoneSignIn(phone.trim());
      setConfirmation(result);
      setStep('code');
    } catch (cause) {
      setError(describeAuthError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode() {
    setBusy(true);
    setError(null);
    try {
      if (!confirmation) throw new Error('No pending verification.');

      await confirmation.confirm(code.trim());

      const idToken = await currentIdToken(true);
      if (!idToken) throw new Error('Firebase did not return an ID token.');

      const { token, user } = await api.firebaseSignIn(idToken);
      await signIn(token, user);
      void registerForPush();
      router.replace(user.role === 'driver' ? '/driver' : '/passenger');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : describeAuthError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Welcome to FairRide</Text>
        <Text style={styles.subtitle}>
          Sign in with your phone number. Your price, your driver, no surprises.
        </Text>

        {step === 'phone' ? (
          <>
            <TextField
              label="Phone number"
              value={phone}
              onChangeText={setPhone}
              placeholder="+15550001234"
              keyboardType="phone-pad"
              autoCapitalize="none"
              autoFocus
            />
            <Text style={styles.hint}>Include your country code, e.g. +44 for the UK.</Text>
            <PrimaryButton label="Send code" onPress={sendCode} loading={busy} disabled={phone.trim().length < 7} />
          </>
        ) : (
          <>
            <TextField
              label="6-digit code"
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />
            <PrimaryButton
              label="Verify and continue"
              onPress={confirmCode}
              loading={busy}
              disabled={code.trim().length !== 6}
            />
            <View style={styles.spacer} />
            <PrimaryButton
              label="Use a different number"
              variant="secondary"
              onPress={() => {
                setStep('phone');
                setCode('');
                setConfirmation(null);
                setError(null);
              }}
            />
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl, paddingTop: spacing.xxl },
  title: { color: colors.text, fontSize: font.display, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: font.body, marginTop: spacing.sm, marginBottom: spacing.xl },
  hint: { color: colors.textMuted, fontSize: font.small, marginTop: -spacing.sm, marginBottom: spacing.lg },
  error: { color: colors.danger, fontSize: font.body, marginTop: spacing.lg },
  spacer: { height: spacing.md },
});
