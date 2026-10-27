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

  it("serves the parser registry", async () => {
    const res = await parsers(new Request("http://localhost/api/v1/alerts/parsers", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.smsSenders).toContain("GTBank");
  });
});
