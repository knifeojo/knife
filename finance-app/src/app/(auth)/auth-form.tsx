"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AuthState } from "./actions";

export function AuthForm({
  mode,
  action,
}: {
  mode: "login" | "signup";
  action: (s: AuthState, f: FormData) => Promise<AuthState>;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const isSignup = mode === "signup";
  return (
    <div className="space-y-4">
    <form action="/api/auth/google" method="post">
      <button className="btn btn-secondary w-full">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/>
        </svg>
        Continue with Google
      </button>
    </form>
    <div className="flex items-center gap-3 text-xs text-ink-3"><span className="h-px flex-1 bg-border" />or with email<span className="h-px flex-1 bg-border" /></div>
    <form action={formAction} className="space-y-4">
      {isSignup && (
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-sm font-medium">Name</label>
          <input id="name" name="name" className="input" autoComplete="name" />
        </div>
      )}
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">Email</label>
        <input id="email" name="email" type="email" required className="input" autoComplete="email" />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          className="input"
          autoComplete={isSignup ? "new-password" : "current-password"}
        />
        {isSignup && <p className="text-xs text-ink-3">At least 8 characters. This is your password for this app only, never your bank password.</p>}
      </div>
      {state?.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Please wait" : isSignup ? "Create account" : "Log in"}
      </button>
      <p className="text-center text-sm text-ink-2">
        {isSignup ? (
          <>Already have an account? <Link href="/login" className="text-accent font-medium">Log in</Link></>
        ) : (
          <>New here? <Link href="/signup" className="text-accent font-medium">Create an account</Link></>
        )}
      </p>
    </form>
    </div>
  );
}
