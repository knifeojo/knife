import { ALL_CATEGORIES } from "@/core/categorize";
import { PeopleInputError, PersonNotFoundError, type PersonInput, type PersonPatch } from "@/core/people";
import { isRelationship } from "@/core/people-match";
import { apiError } from "./http";

// Request bodies for /api/v1/people, checked field by field.

const MAX_NAME = 80;

function names(v: unknown): string[] | { error: string } | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== "string" || !x.trim() || x.length > MAX_NAME)) return { error: "aliases must be a list of names" };
  return v.map((x: string) => x.trim());
}

function vendor(body: Record<string, unknown>): { vendorCategory?: string | null; vendorSubcategory?: string | null } | { error: string } {
  const { vendorCategory, vendorSubcategory } = body;
  if (vendorCategory !== undefined && vendorCategory !== null && (typeof vendorCategory !== "string" || !ALL_CATEGORIES.includes(vendorCategory))) return { error: "Unknown category" };
  if (vendorSubcategory !== undefined && vendorSubcategory !== null && (typeof vendorSubcategory !== "string" || vendorSubcategory.length > 40)) return { error: "vendorSubcategory is too long" };
  return {
    ...(vendorCategory !== undefined && { vendorCategory: vendorCategory as string | null }),
    ...(vendorSubcategory !== undefined && { vendorSubcategory: (vendorSubcategory as string | null)?.trim() || null }),
  };
}

export function personInputFromJson(body: Record<string, unknown>): { input: PersonInput } | { error: string } {
  const { displayName, relationship, note, aliases } = body;
  if (typeof displayName !== "string" || !displayName.trim() || displayName.length > MAX_NAME) return { error: "displayName is required" };
  if (!isRelationship(relationship)) return { error: "Unknown relationship" };
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 120)) return { error: "note is too long" };
  const list = names(aliases);
  if (list && "error" in list) return list;
  const v = vendor(body);
  if ("error" in v) return v;
  return { input: { displayName, relationship, note: (note as string | null | undefined) ?? null, aliases: list, ...v } };
}

export function personPatchFromJson(body: Record<string, unknown>): { patch: PersonPatch } | { error: string } {
  const { displayName, relationship, note, addAliases, rejectAliases, removeAliases } = body;
  const patch: PersonPatch = {};
  if (displayName !== undefined) {
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > MAX_NAME) return { error: "displayName must be a name" };
    patch.displayName = displayName;
  }
  if (relationship !== undefined) {
    if (!isRelationship(relationship)) return { error: "Unknown relationship" };
    patch.relationship = relationship;
  }
  if (note !== undefined) {
    if (note !== null && (typeof note !== "string" || note.length > 120)) return { error: "note is too long" };
    patch.note = note as string | null;
  }
  for (const [k, v] of [["addAliases", addAliases], ["rejectAliases", rejectAliases], ["removeAliases", removeAliases]] as const) {
    const list = names(v);
    if (list && "error" in list) return { error: `${k} must be a list of names` };
    if (list) patch[k] = list;
  }
  const v = vendor(body);
  if ("error" in v) return v;
  Object.assign(patch, v);
  if (!Object.keys(patch).length) return { error: "Nothing to change" };
  return { patch };
}

/** Maps People errors to responses; anything else is rethrown. */
export function peopleError(e: unknown) {
  if (e instanceof PersonNotFoundError) return apiError(404, e.message === "nothing to undo" ? "Nothing to undo" : "Person not found");
  if (e instanceof PeopleInputError) return apiError(400, e.message);
  throw e;
}
