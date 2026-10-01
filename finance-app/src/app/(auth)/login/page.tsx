import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { login } from "../actions";
import { AuthForm } from "../auth-form";

const GOOGLE_ERRORS: Record<string, string> = {
  google_unconfigured: "Google sign-in is not set up on this server yet. The admin needs to add Google OAuth credentials.",
  google_denied: "Google sign-in was cancelled.",
  google_state: "Your sign-in session expired. Please try again.",
  google_failed: "Google sign-in failed. Please try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/app");
  const error = GOOGLE_ERRORS[(await searchParams).error ?? ""];
  return (
    <>
      <h1 className="text-xl font-semibold mb-1">Welcome back</h1>
      <p className="text-sm text-ink-2 mb-6">Log in to see your latest transactions.</p>
      {error && <p role="alert" className="mb-4 rounded-lg bg-warn-bg text-warn-ink text-sm px-3 py-2">{error}</p>}
      <AuthForm mode="login" action={login} />
    </>
  );
}
