import { BANK_SENDERS } from "./senders";

/** Atom XML Gmail can import (Settings → Filters and Blocked Addresses → Import filters). */
export function gmailFilterXml(opts: { forwardTo: string; senders?: string[] }): string {
  const froms = opts.senders ?? BANK_SENDERS.filter((s) => s.channel !== "sms").map((s) => s.id);
  const unique = [...new Set(froms)];
  const entries = unique.map((from) => {
    const escaped = escapeXml(from);
    return `  <entry>
    <category term="filter"/>
    <title>Ledger bank alerts from ${escaped}</title>
    <apps:property name="from" value="${escaped}"/>
    <apps:property name="forwardTo" value="${escapeXml(opts.forwardTo)}"/>
    <apps:property name="sizeOperator" value="s_sl"/>
    <apps:property name="sizeUnit" value="s_smb"/>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/publication/2006">
  <title>Ledger bank-alert filters</title>
  <id>tag:ledger:filters:bank-alerts</id>
${entries.join("\n")}
</feed>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
