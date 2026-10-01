import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { signup } from "../actions";
import { AuthForm } from "../auth-form";

export default async function SignupPage() {
  if (await getCurrentUser()) redirect("/app");
  return (
    <>
      <h1 className="text-xl font-semibold mb-1">Create your account</h1>
      <p className="text-sm text-ink-2 mb-6">We will never ask for your bank login, PIN or OTP.</p>
      <AuthForm mode="signup" action={signup} />
    </>
  );
}
