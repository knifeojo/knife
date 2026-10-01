"use client";

import { useTransition } from "react";
import { ALL_CATEGORIES } from "@/core/categorize";
import { recategorizeAction } from "@/app/app/actions";

export function CategorySelect({ id, value }: { id: string; value: string }) {
  const [pending, start] = useTransition();
  return (
    <select
      aria-label="Category"
      defaultValue={value}
      disabled={pending}
      onChange={(e) => {
        const fd = new FormData();
        fd.set("id", id);
        fd.set("category", e.target.value);
        start(() => recategorizeAction(fd));
      }}
      className="bg-surface-2 rounded-md px-2 py-1 text-xs border border-transparent hover:border-border disabled:opacity-50"
    >
      {ALL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}
