import type { User } from '@fairride/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api } from '../lib/api';
import { deleteSecret, readSecret, writeSecret } from '../lib/storage';

const TOKEN_KEY = 'fairride.token';
const USER_KEY = 'fairride.user';

interface AuthContextValue {
  /** False until the persisted session has been read; avoids a flash of sign-in. */
  ready: boolean;
  user: User | null;
  token: string | null;
  signIn: (token: string, user: User) => Promise<void>;
  updateUser: (user: User) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  // Restore the session once on mount and hand the token to the API client.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedToken, storedUser] = await Promise.all([readSecret(TOKEN_KEY), readSecret(USER_KEY)]);
      if (cancelled) return;
      if (storedToken) {
        api.setToken(storedToken);
        setToken(storedToken);
        if (storedUser) {
          try {
            setUser(JSON.parse(storedUser) as User);
          } catch {
            // A corrupt blob just means re-authentication; not worth crashing.
          }
        }
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (nextToken: string, nextUser: User) => {
    api.setToken(nextToken);
    setToken(nextToken);
    setUser(nextUser);
    await Promise.all([writeSecret(TOKEN_KEY, nextToken), writeSecret(USER_KEY, JSON.stringify(nextUser))]);
  }, []);

  const updateUser = useCallback(async (nextUser: User) => {
    setUser(nextUser);
    await writeSecret(USER_KEY, JSON.stringify(nextUser));
  }, []);

  const signOut = useCallback(async () => {
    // Drop the server-side device registration and the Firebase session first,
    // then clear local state. Each step is best-effort: a failure to reach the
    // API must not leave the user stuck inside the app.
    try {
      const { unregisterForPush } = await import('../lib/push');
      await unregisterForPush();
    } catch {
      // Ignore.
    }
    try {
      const { signOutOfFirebase } = await import('../lib/firebase');
      await signOutOfFirebase();
    } catch {
      // Ignore.
    }

    api.setToken(null);
    setToken(null);
    setUser(null);
    await Promise.all([deleteSecret(TOKEN_KEY), deleteSecret(USER_KEY)]);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ready, user, token, signIn, updateUser, signOut }),
    [ready, user, token, signIn, updateUser, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}
