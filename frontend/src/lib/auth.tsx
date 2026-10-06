import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut as fbSignOut } from "firebase/auth";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setTokenGetter } from "./api";
import { firebaseEnabled, getFirebaseAuth } from "./firebase";

export interface SessionUser {
  email: string;
  name?: string | null;
}

interface AuthCtx {
  user: SessionUser | null;
  loading: boolean;
  /** true when Firebase is not configured and the local dev login is used */
  devMode: boolean;
  signInGoogle: () => Promise<void>;
  signInDev: (email: string) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);
const DEV_KEY = "automl-dev-email";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (firebaseEnabled) {
      const auth = getFirebaseAuth();
      setTokenGetter(async () => (auth.currentUser ? auth.currentUser.getIdToken() : null));
      return onAuthStateChanged(auth, (u) => {
        setUser(u?.email ? { email: u.email, name: u.displayName } : null);
        setLoading(false);
      });
    }
    setTokenGetter(async () => {
      const e = localStorage.getItem(DEV_KEY);
      return e ? `dev:${e}` : null;
    });
    const saved = localStorage.getItem(DEV_KEY);
    setUser(saved ? { email: saved } : null);
    setLoading(false);
  }, []);

  const signInGoogle = useCallback(async () => {
    await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
  }, []);

  const signInDev = useCallback((email: string) => {
    const e = email.trim().toLowerCase();
    localStorage.setItem(DEV_KEY, e);
    setUser({ email: e });
  }, []);

  const signOut = useCallback(async () => {
    if (firebaseEnabled) await fbSignOut(getFirebaseAuth());
    localStorage.removeItem(DEV_KEY);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, devMode: !firebaseEnabled, signInGoogle, signInDev, signOut }),
    [user, loading, signInGoogle, signInDev, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
