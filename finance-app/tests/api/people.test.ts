import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { GET as reviewGet, POST as reviewPost } from "@/app/api/v1/review/route";
import { GET as peopleGet, POST as peoplePost } from "@/app/api/v1/people/route";
import { DELETE as personDelete, PATCH as personPatch } from "@/app/api/v1/people/[id]/route";
import { POST as mergePost } from "@/app/api/v1/people/merge/route";
import { POST as undoPost } from "@/app/api/v1/people/undo/route";

const CSV = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "25-Jul-2026,A1,150000.00,,1850000.00,Instant Payment Outward 0725 TO OPAY - GIFT ADEBAYO OJO",
  "26-Jul-2026,A2,80000.00,,1770000.00,NIP TRANSFER TO PALMPAY - OJO GIFT A",
  "27-Jul-2026,A3,200000.00,,1570000.00,Instant Payment Outward 0727 TO OPAY - TUNDE OJO",
  "26-Aug-2026,A4,,30000.00,1600000.00,NIP TRANSFER FROM GIFT ADEBAYO OJO",
  "27-Aug-2026,A5,50000.00,,1550000.00,Instant Payment Outward 0827 TO OPAY - TUNDE OJO",
].join("\n"));

let n = 0;
async function setup() {
  const u = await db.user.create({ data: { email: `api-people${++n}@test.dev` } });
  await importStatement(u.id, { name: "s.csv", bytes: CSV }, { institution: "GTBank" });
  const { token } = await issueSession(u.id);
  return { userId: u.id, token };
}

function req(path: string, token: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type Json = Record<string, unknown> & { people: { id: string; displayName: string; relationship: string; outMinor: string; inMinor: string; aliases: { name: string }[]; months: unknown[] }[] };

describe("/api/v1/review with people questions", () => {
  it("returns person stats, option groups and relationships, and takes a one-tap relationship", async () => {
    const { userId, token } = await setup();
    const body = await (await reviewGet(req("/api/v1/review", token))).json();
    const q = body.questions.find((x: { key: string }) => x.key === "gift adebayo ojo");
    expect(body.questions[0].person).not.toBeNull();
    expect(q).toMatchObject({
      kind: "person", title: "Who is Gift Adebayo Ojo to you?", allowsOther: true, aiRelationship: null,
      person: { inCount: 1, inMinor: "3000000", outCount: 2, outMinor: "23000000", lastDate: "2026-08-26" },
    });
    expect(q.options).toContainEqual({ value: "rel:spouse", label: "Spouse / partner", category: "Family", subcategory: "Spouse", group: "relationship" });
    expect(q.options).toContainEqual(expect.objectContaining({ value: "not_person", group: "control" }));
    expect(q.options).toContainEqual(expect.objectContaining({ value: "landlord", group: "more" }));
    expect(body.relationships.map((r: { value: string }) => r.value)).toContain("extended");

    expect((await reviewPost(req("/api/v1/review", token, "POST", { kind: "person", key: "gift adebayo ojo", value: "rel:aunt" }))).status).toBe(400);
    const res = await reviewPost(req("/api/v1/review", token, "POST", { kind: "person", key: "gift adebayo ojo", value: "rel:spouse" }));
    expect(await res.json()).toEqual({ updated: 3 });
    expect(await db.transaction.count({ where: { userId, subcategory: "Spouse" } })).toBe(2);

    const vendor = await reviewPost(req("/api/v1/review", token, "POST", { kind: "person", key: "tunde ojo", value: "rel:vendor", vendorCategory: "Housing", vendorSubcategory: "Home services" }));
    expect(vendor.status).toBe(200);
    expect(await db.transaction.count({ where: { userId, subcategory: "Home services" } })).toBe(2);
    expect((await reviewPost(req("/api/v1/review", token, "POST", { kind: "person", key: "x y", value: "rel:vendor", vendorCategory: "Nope" }))).status).toBe(400);
  });
});

describe("/api/v1/people", () => {
  it("needs a session", async () => {
    expect((await peopleGet(new Request("http://localhost/api/v1/people"))).status).toBe(401);
  });

  it("adds from text, lists totals, edits, merges, removes and undoes", async () => {
    const { userId, token } = await setup();
    const empty = await (await peopleGet(req("/api/v1/people", token))).json();
    expect(empty).toMatchObject({ people: [], undo: null });
    expect(empty.relationships).toContainEqual({ value: "spouse", label: "Spouse / partner" });

    const bad = await peoplePost(req("/api/v1/people", token, "POST", { text: "hello" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ unread: ["hello"] });

    const added = await peoplePost(req("/api/v1/people", token, "POST", { text: "My wife is Gift Adebayo Ojo" }));
    expect(added.status).toBe(201);
    const a = (await added.json()) as Json;
    expect(a).toMatchObject({ added: 1, updated: 3, unread: [] });
    expect(a.people[0]).toMatchObject({ displayName: "Gift Adebayo Ojo", relationship: "spouse", outMinor: "23000000", inMinor: "3000000" });
    expect(a.people[0].months).toHaveLength(6);

    expect((await peoplePost(req("/api/v1/people", token, "POST", { displayName: "Tunde Ojo", relationship: "cousin" }))).status).toBe(400);
    const tunde = (await (await peoplePost(req("/api/v1/people", token, "POST", { displayName: "Tunde Ojo", relationship: "sibling", note: "brother" }))).json()) as Json & { id: string };
    expect(await db.transaction.count({ where: { userId, subcategory: "Siblings" } })).toBe(2);

    const patched = await personPatch(req(`/api/v1/people/${tunde.id}`, token, "PATCH", { relationship: "extended", addAliases: ["OJO TUNDE B"] }), params(tunde.id));
    expect(patched.status).toBe(200);
    expect(await db.transaction.count({ where: { userId, subcategory: "Black tax" } })).toBe(2);
    expect((await personPatch(req(`/api/v1/people/${tunde.id}`, token, "PATCH", {}), params(tunde.id))).status).toBe(400);
    expect((await personPatch(req("/api/v1/people/nope", token, "PATCH", { relationship: "friend" }), params("nope"))).status).toBe(404);

    const undone = await (await undoPost(req("/api/v1/people/undo", token, "POST", {}))).json();
    expect(undone).toMatchObject({ restored: 2 });
    expect(await db.transaction.count({ where: { userId, subcategory: "Siblings" } })).toBe(2);

    const merged = (await (await mergePost(req("/api/v1/people/merge", token, "POST", { targetId: a.people[0].id, sourceId: tunde.id }))).json()) as Json;
    expect(merged.people).toHaveLength(1);
    expect(merged.people[0].aliases.map((x) => x.name)).toContain("Tunde Ojo");
    expect((await mergePost(req("/api/v1/people/merge", token, "POST", { targetId: a.people[0].id, sourceId: a.people[0].id }))).status).toBe(400);
    await undoPost(req("/api/v1/people/undo", token, "POST", {}));

    const removed = await personDelete(req(`/api/v1/people/${tunde.id}`, token, "DELETE"), params(tunde.id));
    expect(((await removed.json()) as Json).people.map((p) => p.displayName)).toEqual(["Gift Adebayo Ojo"]);
  });

  it("is scoped to the signed-in owner", async () => {
    const one = await setup();
    const two = await setup();
    const res = (await (await peoplePost(req("/api/v1/people", one.token, "POST", { displayName: "Gift Adebayo Ojo", relationship: "spouse" }))).json()) as { id: string };
    expect((await personPatch(req(`/api/v1/people/${res.id}`, two.token, "PATCH", { relationship: "friend" }), params(res.id))).status).toBe(404);
    expect((await personDelete(req(`/api/v1/people/${res.id}`, two.token, "DELETE"), params(res.id))).status).toBe(404);
    expect((await undoPost(req("/api/v1/people/undo", two.token, "POST", {}))).status).toBe(404);
    expect(((await (await peopleGet(req("/api/v1/people", two.token))).json()) as Json).people).toEqual([]);
  });
});
