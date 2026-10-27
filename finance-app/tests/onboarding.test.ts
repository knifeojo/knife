import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { finishTopPeople, onboardingState, saveOnboarding, splitNames } from "@/core/onboarding";
import { issueSession } from "@/lib/auth";
import { GET as onboardGet, POST as onboardPost } from "@/app/api/v1/onboarding/route";

function statement(lines: string[]): Buffer {
  return Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks", ...lines].join("\n"));
}

describe("splitNames", () => {
  it("reads commas, and, slashes and new lines", () => {
    expect(splitNames("Ada Bello, Tunde Bello and Ngozi Ade\nFunke Lawal")).toEqual(["Ada Bello", "Tunde Bello", "Ngozi Ade", "Funke Lawal"]);
  });
});

describe("onboarding", () => {
  it("is needed once, skippable, and stores people without sending names anywhere", async () => {
    const u = await db.user.create({ data: { email: "onboard1@test.dev" } });
    const before = await onboardingState(u.id);
    expect(before.needsOnboarding).toBe(true);
    expect(before.trustNote).toMatch(/never sent to the cloud/);
    expect(before.topPeople.show).toBe(false);

    const skipped = await saveOnboarding(u.id, { skip: true });
    expect(skipped.added).toBe(0);
    expect((await onboardingState(u.id)).needsOnboarding).toBe(false);
    expect(await db.person.count({ where: { userId: u.id } })).toBe(0);
  });

  it("saves the owner's name and family as Person records", async () => {
    const u = await db.user.create({ data: { email: "onboard2@test.dev" } });
    const { added } = await saveOnboarding(u.id, {
      ownName: "Ada Okonkwo",
      relationshipStatus: "married",
      partners: ["Chidi Okonkwo"],
      parents: ["Eze Okonkwo", "Ngozi Okonkwo"],
      siblings: ["Tunde Okonkwo"],
      supported: ["Amaka Obi"],
    });
    expect(added).toBe(6);
    const people = await db.person.findMany({ where: { userId: u.id }, orderBy: { relationship: "asc" } });
    expect(people.map((p) => [p.relationship, p.displayName])).toEqual(expect.arrayContaining([
      ["me", "Ada Okonkwo"],
      ["spouse", "Chidi Okonkwo"],
      ["parent", "Eze Okonkwo"],
      ["parent", "Ngozi Okonkwo"],
      ["sibling", "Tunde Okonkwo"],
      ["extended", "Amaka Obi"],
    ]));
    const user = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(user).toMatchObject({ name: "Ada Okonkwo", relationshipStatus: "married" });
    expect(user.onboardedAt).toBeTruthy();
  });

  it("after the first upload, lists the people they send the most to", async () => {
    const u = await db.user.create({ data: { email: "onboard3@test.dev" } });
    await saveOnboarding(u.id, { skip: true });
    await importStatement(u.id, {
      name: "s.csv",
      bytes: statement([
        "02-Sep-2026,T1,300000.00,,1700000.00,Instant Payment Outward TO OPAY - CHIDI OKONKWO",
        "03-Sep-2026,T2,80000.00,,1620000.00,Instant Payment Outward TO OPAY - TUNDE EZE",
        "04-Sep-2026,T3,5000.00,,1615000.00,Instant Payment Outward TO OPAY - KEMI TAIWO",
      ]),
    }, { institution: "GTBank" });
    const state = await onboardingState(u.id);
    expect(state.needsOnboarding).toBe(false);
    expect(state.topPeople.show).toBe(true);
    expect(state.topPeople.people.map((p) => p.display.toLowerCase())).toEqual(["chidi okonkwo", "tunde eze", "kemi taiwo"]);
    await finishTopPeople(u.id);
    expect((await onboardingState(u.id)).topPeople.show).toBe(false);
  });
});

describe("/api/v1/onboarding", () => {
  function req(token: string, method = "GET", body?: unknown) {
    return new Request("http://localhost/api/v1/onboarding", {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  it("returns the form, accepts skip and a family save", async () => {
    const u = await db.user.create({ data: { email: "onboard-api@test.dev" } });
    const { token } = await issueSession(u.id);
    const get = await (await onboardGet(req(token))).json();
    expect(get.needsOnboarding).toBe(true);
    expect(get.trustNote).toMatch(/never sent to the cloud/);
    expect(get.statuses.map((s: { value: string }) => s.value)).toContain("married");

    expect((await onboardPost(req(token, "POST", { skip: true }))).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).onboardedAt).toBeTruthy();

    const u2 = await db.user.create({ data: { email: "onboard-api2@test.dev" } });
    const { token: t2 } = await issueSession(u2.id);
    const saved = await onboardPost(req(t2, "POST", { ownName: "Ada Okonkwo", relationshipStatus: "married", partner: "Chidi Okonkwo", parents: "Eze Okonkwo and Ngozi Okonkwo" }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ added: 4, needsOnboarding: false });
    expect(await db.person.count({ where: { userId: u2.id } })).toBe(4);
  });
});
