"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth";
import { randomToken } from "@/lib/crypto";
import { seedDemoUser } from "@/core/demo";
import { log } from "@/lib/log";

export type AuthState = { error?: string } | undefined;

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(80).optional(),
});

export async function signup(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password"), name: form.get("name") || undefined });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { email, password, name } = parsed.data;
  if (await db.user.findUnique({ where: { email } })) return { error: "An account with this email already exists. Log in instead." };
  const user = await db.user.create({ data: { email, name, passwordHash: await hashPassword(password) } });
  await createSession(user.id);
  log.info("auth.signup", { userId: user.id });
  redirect("/app");
}

export async function login(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = credentials.omit({ name: true }).safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: "Invalid email or password" };
  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  // Same message for unknown user and bad password
  if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) return { error: "Invalid email or password" };
  await createSession(user.id);
  redirect("/app");
}

export async function logout() {
  await destroySession();
  redirect("/");
}

/** Every "Try demo" click gets a private, disposable sandbox user. */
export async function startDemo() {
  // Housekeeping: drop demo sandboxes older than a day
  await db.user.deleteMany({ where: { isDemo: true, createdAt: { lt: new Date(Date.now() - 86400_000) } } });
  const user = await db.user.create({
    data: { email: `demo-${randomToken(8)}@demo.local`, name: "Demo User", isDemo: true },
  });
  await seedDemoUser(user.id);
  await createSession(user.id);
  redirect("/app");
}
