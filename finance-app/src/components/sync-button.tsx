"use client";

import { useActionState } from "react";
import type { SyncState } from "@/app/app/actions";

export function SyncButton({
  action,
  provider,
  connectionId,
  label = "Sync now",
  variant = "secondary",
}: {
  action: (s: SyncState, f: FormData) => Promise<SyncState>;
  provider?: string;
  connectionId?: string;
  label?: string;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-2">
      {provider && <input type="hidden" name="provider" value={provider} />}
      {connectionId && <input type="hidden" name="connectionId" value={connectionId} />}
      <button className={`btn btn-${variant}`} disabled={pending}>{pending ? "Scanning alerts..." : label}</button>
      {state?.ok && <p className="text-sm text-accent" role="status">{state.ok}</p>}
      {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
    </form>
  );
}
