import { describe, expect, it } from "vitest";
import { gmailFilterXml } from "@/core/alerts/filters";

describe("Gmail filter XML", () => {
  it("forwards only listed bank senders to the personal address", () => {
    const xml = gmailFilterXml({ forwardTo: "alerts-tok@example.com", senders: ["gtbank.com", "firstbanknigeria.com"] });
    expect(xml).toContain("<?xml version=\"1.0\"");
    expect(xml).toContain('name="from" value="gtbank.com"');
    expect(xml).toContain('name="forwardTo" value="alerts-tok@example.com"');
    expect(xml).toContain("firstbanknigeria.com");
    expect(xml).not.toContain("accessbankplc.com");
    expect(xml).not.toContain("<script");
  });
});
