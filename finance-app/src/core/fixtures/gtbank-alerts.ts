// SYNTHETIC GTBank alert emails for tests and the "Import sample alerts" flow.
// Modelled on the two known layouts (GeNS table and prose). Names, accounts and
// references are fabricated. Replace or extend with real anonymized samples.
import type { EmailMessage } from "../types";

const SENDER = "GeNS <gens@gtbank.com>";

function gensHtml(opts: {
  kind: "Debit" | "Credit";
  account: string;
  description: string;
  amount: string;
  valueDate: string;
  remarks?: string;
  time: string;
  doc?: string;
  current?: string;
  available?: string;
}): string {
  const row = (label: string, value?: string) =>
    value === undefined ? "" : `<tr><td class="label"><b>${label}</b></td><td>:</td><td>${value}</td></tr>`;
  return `<!DOCTYPE html><html><head><style>td{font-family:Arial}</style></head><body>
<table width="600"><tr><td><img src="https://gtbank.example/logo.png" alt="GTBank"/></td></tr></table>
<p>Dear Customer,</p>
<p>Guaranty Trust Bank Electronic Notification Service (GeNS)</p>
<p>We wish to inform you that a ${opts.kind} transaction occurred on your account with us.</p>
<p>The details of this transaction are shown below:</p>
<table cellpadding="4">
<tr><td colspan="3"><b>Transaction Notification</b></td></tr>
${row("Account Number", opts.account)}
${row("Transaction Location", "205")}
${row("Description", opts.description)}
${row("Amount", opts.amount)}
${row("Value Date", opts.valueDate)}
${row("Remarks", opts.remarks)}
${row("Time of Transaction", opts.time)}
${row("Document Number", opts.doc)}
${row("Current Balance", opts.current)}
${row("Available Balance", opts.available)}
</table>
<p>Thank you for choosing GTBank.</p>
</body></html>`;
}

export const GTBANK_FIXTURES: Record<string, EmailMessage> = {
  gensDebitTransfer: {
    id: "fx-001",
    from: SENDER,
    subject: "GeNS Transaction Alert [Debit: NGN250,000.00]",
    date: new Date("2026-09-25T09:15:00Z"),
    html: gensHtml({
      kind: "Debit",
      account: "01******4521",
      description: "TRF/RENT SEPT/FRM ADA OKAFOR TO OLUWASEUN ADEYEMI",
      amount: "NGN 250,000.00",
      valueDate: "25-Sep-2026",
      remarks: "RENT SEPT",
      time: "10:14:52 AM",
      doc: "000013260925101452001",
      current: "NGN 4,500,000.00",
      available: "NGN 4,500,000.00",
    }),
  },
  gensCreditSalary: {
    id: "fx-002",
    from: SENDER,
    subject: "GeNS Transaction Alert [Credit: NGN1,983,611.00]",
    date: new Date("2026-09-24T14:02:00Z"),
    html: gensHtml({
      kind: "Credit",
      account: "01******4521",
      description: "NIP/ACME TECHNOLOGIES LTD/SALARY SEPTEMBER 2026",
      amount: "NGN 1,983,611.00",
      valueDate: "24-Sep-2026",
      time: "03:01:17 PM",
      doc: "090110260924150117002",
      current: "NGN 4,750,000.00",
      available: "NGN 4,750,000.00",
    }),
  },
  proseDebit: {
    id: "fx-003",
    from: "GTBank Alerts <alerts@gtbank.com>",
    subject: "Transaction Alert",
    date: new Date("2026-09-22T18:40:00Z"),
    text: `Transaction Alert

Your account has been debited with NGN 85,000.00

Account Number: ******4521
Transaction Date: 22/09/2026
Description: POS/BOLT TECHNOLOGY OU/LAGOS NG
Available Balance: NGN 2,766,389.00
Reference: ABC123

Guaranty Trust Bank`,
  },
  proseCreditPesa: {
    id: "fx-004",
    from: "GTBank Alerts <alerts@gtbank.com>",
    subject: "Credit Alert",
    date: new Date("2026-09-20T11:00:00Z"),
    text: `Dear Customer,

Your account has been credited with NGN 666,800.00

Transaction Date: 20/09/2026
Description: NIP/PESA PAYMENTS LTD/CONSULTING INVOICE 014
Available Balance: NGN 2,851,389.00
Reference: PSA7781204

Guaranty Trust Bank`,
  },
  gensPosShoprite: {
    id: "fx-005",
    from: SENDER,
    subject: "GeNS Transaction Alert [Debit: NGN45,250.50]",
    date: new Date("2026-09-19T16:30:00Z"),
    html: gensHtml({
      kind: "Debit",
      account: "01******4521",
      description: "POS PURCHASE SHOPRITE LEKKI LAGOS",
      amount: "NGN 45,250.50",
      valueDate: "19-Sep-2026",
      time: "05:29:03 PM",
      doc: "POS260919172903",
      current: "NGN 2,184,589.00",
      available: "NGN 2,184,589.00",
    }),
  },
  gensNetflix: {
    id: "fx-006",
    from: SENDER,
    subject: "GeNS Transaction Alert [Debit: NGN7,000.00]",
    date: new Date("2026-09-15T08:00:00Z"),
    html: gensHtml({
      kind: "Debit",
      account: "01******4521",
      description: "WEB PURCHASE NETFLIX.COM LOS GATOS",
      amount: "NGN 7,000.00",
      valueDate: "15-Sep-2026",
      time: "09:00:12 AM",
      doc: "WEB260915090012",
      available: "NGN 2,229,839.50",
    }),
  },
  gensSmsFee: {
    id: "fx-007",
    from: SENDER,
    subject: "GeNS Transaction Alert [Debit: NGN24.00]",
    date: new Date("2026-09-25T22:59:00Z"),
    html: gensHtml({
      kind: "Debit",
      account: "01******4521",
      description: "SMS ALERT CHARGES SEP 2026",
      amount: "NGN 24.00",
      valueDate: "25-Sep-2026",
      time: "11:59:00 PM",
      doc: "SMSCHG260930",
      available: "NGN 4,499,976.00",
    }),
  },
  missingOptionalFields: {
    id: "fx-008",
    from: SENDER,
    subject: "GeNS Transaction Alert",
    date: new Date("2026-09-12T12:00:00Z"),
    text: `Guaranty Trust Bank Electronic Notification Service (GeNS)
We wish to inform you that a Debit transaction occurred on your account with us.
Amount : NGN5000
Description : UBER TRIP HELP.UBER.COM`,
  },
  usdCredit: {
    id: "fx-009",
    from: SENDER,
    subject: "GeNS Transaction Alert [Credit: USD1,200.00]",
    date: new Date("2026-09-10T10:00:00Z"),
    html: gensHtml({
      kind: "Credit",
      account: "02******9901",
      description: "SWIFT INWARD/UPWORK ESCROW INC",
      amount: "USD 1,200.00",
      valueDate: "2026-09-10",
      time: "11:00:00 AM",
      doc: "SWF26091000123",
      available: "USD 3,450.00",
    }),
  },
  // Bank resent the same alert under a new message id. Must not create a second transaction.
  gensDebitTransferResent: {
    id: "fx-010",
    from: SENDER,
    subject: "GeNS Transaction Alert [Debit: NGN250,000.00]",
    date: new Date("2026-09-25T09:47:00Z"),
    html: gensHtml({
      kind: "Debit",
      account: "01******4521",
      description: "TRF/RENT SEPT/FRM ADA OKAFOR TO OLUWASEUN ADEYEMI",
      amount: "NGN 250,000.00",
      valueDate: "25-Sep-2026",
      remarks: "RENT SEPT",
      time: "10:14:52 AM",
      doc: "000013260925101452001",
      current: "NGN 4,500,000.00",
      available: "NGN 4,500,000.00",
    }),
  },
  marketing: {
    id: "fx-011",
    from: "GTBank <gtbank@gtbank.com>",
    subject: "Introducing the new GTWorld app",
    date: new Date("2026-09-09T10:00:00Z"),
    html: "<p>Guaranty Trust Bank: enjoy faster transfers on GTWorld. Download today.</p>",
  },
  malformedAlert: {
    id: "fx-012",
    from: SENDER,
    subject: "GeNS Transaction Alert",
    date: new Date("2026-09-08T10:00:00Z"),
    text: "Guaranty Trust Bank (GeNS). A transaction occurred on your account. Amount : NGN ###",
  },
  otherBank: {
    id: "fx-013",
    from: "Access Bank <alerts@accessbankplc.com>",
    subject: "Debit Alert",
    date: new Date("2026-09-08T10:00:00Z"),
    text: "Your Access Bank account has been debited with NGN 10,000.00",
  },
};

/** Fixtures that represent real transactions (used by "Import sample alerts"). */
export const SAMPLE_INBOX: EmailMessage[] = Object.values(GTBANK_FIXTURES);
