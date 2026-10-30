import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { POST as sms } from "@/app/api/v1/alerts/sms/route";
import { GET as parsers } from "@/app/api/v1/alerts/parsers/route";
import { resetRateLimits } from "@/lib/rate-limit";

const BODY = `Acct:******1234
Amt:NGN3,450.00 DR
Desc:OUTWARD TRANSFER TO MONIEMFB - JANE DOE
Bal:NGN412,890.50
Date:2026-10-07 3:17PM`;

function post(path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("SMS ingest API", () => {
  let token: string;
  let smsToken: string;

  beforeAll(async () => {
    resetRateLimits();
    const user = await db.user.create({ data: { email: "sms-api@test.dev", smsIngestToken: "smsTok1234567890ab" } });
    smsToken = user.smsIngestToken!;
    token = (await issueSession(user.id)).token;
  });

  it("accepts a session bearer and an iOS Shortcuts token", async () => {
    const a = await sms(post("/api/v1/alerts/sms", { sender: "GTBank", body: BODY, receivedAt: "2026-10-07T14:17:00.000Z", sourceId: "s1" }, { authorization: `Bearer ${token}` }));
    expect(a.status).toBe(200);
    const bodyA = await a.json();
    expect(bodyA.results[0].status).toBe("created");

    const b = await sms(post("/api/v1/alerts/sms", { sender: "GTBank", body: BODY, receivedAt: "2026-10-07T14:17:00.000Z", sourceId: "s1" }, { "x-ledger-sms-token": smsToken }));
    expect(b.status).toBe(200);
    expect((await b.json()).results[0].status).toBe("duplicate");
  });

  it("refuses a personal number even if posted", async () => {
    const res = await sms(post("/api/v1/alerts/sms", { sender: "08012345678", body: BODY }, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].status).toBe("skipped");
  });

  it("reviews an unknown fintech sender once and skips OTP and promo", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { email: "sms-api@test.dev" } });
    const before = await db.transaction.count({ where: { userId: user.id } });
    const body = "Credit of NGN15,000.00 into wallet ****4821. Avl Bal: NGN27,430.50. Desc: WALLET FUNDING FROM EMPLOYER";
    const first = await sms(
      post("/api/v1/alerts/sms", { sender: "Renmoney", body, receivedAt: "2026-10-20T09:00:00.000Z", sourceId: "ren-1" }, { authorization: `Bearer ${token}` }),
    );
    expect(first.status).toBe(200);
    const created = await first.json();
    expect(created.results[0].status).toBe("review");
    expect(created.results[0].parser).toBe("GenericFallback");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(before);

    const again = await sms(
      post("/api/v1/alerts/sms", { sender: "Renmoney", body, receivedAt: "2026-10-20T09:00:00.000Z", sourceId: "ren-1" }, { authorization: `Bearer ${token}` }),
    );
    expect((await again.json()).results[0].status).toBe("review");
    expect(await db.unparsedAlert.count({ where: { userId: user.id, sender: "Renmoney" } })).toBe(1);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(before);

    const otp = await sms(
      post("/api/v1/alerts/sms", { sender: "GTBank", body: "Your OTP is 482193. Do not share this code." }, { authorization: `Bearer ${token}` }),
    );
    expect((await otp.json()).results[0].status).toBe("skipped");
    const promo = await sms(
      post(
        "/api/v1/alerts/sms",
        { sender: "Renmoney", body: "Congratulations! You have won N500,000. Dial *123# to claim." },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect((await promo.json()).results[0].status).toBe("skipped");
  });

  it("serves the parser registry", async () => {
    const res = await parsers(new Request("http://localhost/api/v1/alerts/parsers", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.smsSenders).toContain("GTBank");
  });
});
