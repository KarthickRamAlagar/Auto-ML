import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/progress";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";

export default function Login() {
  useSeo({ title: "Sign in · Auto ML", noindex: true });
  const { user, loading, devMode, signInGoogle, signInDev } = useAuth();
  const loc = useLocation();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const from = (loc.state as { from?: string } | null)?.from ?? "/auto-ml";

  if (loading) return <div className="grid min-h-dvh place-items-center"><Spinner /></div>;
  if (user) return <Navigate to={from} replace />;

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 shadow-sm">
        <div className="text-center">
          <Logo size="lg" className="justify-center" />
          <p className="mt-3 text-sm text-muted-foreground">Sign in to train and compare machine learning models.</p>
        </div>
        {!devMode && (
          <Button
            className="w-full"
            size="lg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await signInGoogle();
              } catch (e) {
                setErr((e as Error).message.replace("Firebase: ", ""));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : null} Continue with Google
          </Button>
        )}
        {devMode && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) signInDev(email);
              else setErr("Enter a valid email.");
            }}
          >
            <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">Local dev login: Firebase is not configured. This is disabled in production.</p>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" autoFocus />
            <Button type="submit" className="w-full" size="lg">
              Continue
            </Button>
          </form>
        )}
        {err && <p className="text-center text-sm text-destructive">{err}</p>}
        <p className="text-center text-xs text-muted-foreground">We store only your email, usage and payments. Datasets are never saved.</p>
      </div>
    </div>
  );
}
