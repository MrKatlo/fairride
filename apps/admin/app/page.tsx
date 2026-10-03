'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AdminApiError, devSignIn, getToken, setToken } from '@/lib/api';

/**
 * There is no admin password flow yet; production should use the same OTP login
 * as the app, with the role enforced server-side. This page exists so an
 * operator can get a token in development without curl.
 */
export default function SignInPage() {
  const router = useRouter();
  const [userId, setUserId] = useState('usr_admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken()) router.replace('/dashboard');
  }, [router]);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const token = await devSignIn(userId.trim() || 'usr_admin');
      setToken(token);
      router.replace('/dashboard');
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: '10vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>FairRide Admin</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        Development sign-in. In production, admins authenticate through the phone OTP flow.
      </p>

      <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Admin user id</label>
      <input
        value={userId}
        onChange={(event) => setUserId(event.target.value)}
        style={{
          width: '100%',
          padding: 12,
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
        }}
      />

      {error ? <p style={{ color: 'var(--danger)' }}>{error}</p> : null}

      <button
        onClick={signIn}
        disabled={busy}
        style={{
          marginTop: 16,
          width: '100%',
          padding: 12,
          borderRadius: 10,
          border: 'none',
          background: 'var(--primary)',
          color: '#04121b',
          fontWeight: 700,
        }}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </main>
  );
}
