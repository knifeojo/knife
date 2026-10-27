// Destination country/currency inferred from a wallet or bank payout narration.
// Low confidence: Ledger never invents the amount the recipient received.

export type DestinationChannel = "mobile_money" | "bank";

export interface DestinationHint {
  country: string;
  countryCode: string;
  currency: string;
  channel: DestinationChannel;
  /** Shown on the row: "Sent to Ghana (mobile money)". */
  label: string;
  confidence: number;
  /** The person named before the phone or account, when the pattern is a person transfer. */
  personName?: string;
  isPersonTransfer: boolean;
}

const WALLET_BRAND = "mtn|vodafone|airteltigo|airtel ?tigo|m-?pesa|orange(?:\\s+money)?|moov|wave";
const NG_BANK = "guaranty\\s*trust(?:\\s+bank)?|gtbank|\\bgtb\\b|opay|moniepoint|first\\s*bank(?:\\s+plc)?|stanbic(?:ibtc|\\s+ibtc)?|access(?:\\s+bank)?|uba|zenith|fidelity|wema|kuda|palmpay|first\\s*bank";

const DIAL: { code: string; country: string; countryCode: string; currency: string }[] = [
  { code: "233", country: "Ghana", countryCode: "GH", currency: "GHS" },
  { code: "229", country: "Benin", countryCode: "BJ", currency: "XOF" },
  { code: "254", country: "Kenya", countryCode: "KE", currency: "KES" },
  { code: "234", country: "Nigeria", countryCode: "NG", currency: "NGN" },
];

function titleName(raw: string): string | undefined {
  const t = raw.replace(/[^A-Za-z .'-]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 2) return undefined;
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 48);
}

function labelFor(country: string, channel: DestinationChannel): string {
  return channel === "mobile_money" ? `Sent to ${country} (mobile money)` : `Sent to ${country}`;
}

const PERSON_MOMO = new RegExp(
  `([A-Za-z][A-Za-z .'-]{1,60}?)\\s*/\\s*\\+?((?:233|229|254|234)\\d{7,12})\\s*/\\s*(${WALLET_BRAND})\\b`,
  "i",
);
const BARE_DIAL = new RegExp(`\\+(233|229|254|234)\\d{7,12}\\b`);
const NG_ACCOUNT = new RegExp(
  `([A-Za-z][A-Za-z .'-]{1,60}?)\\s*/\\s*(\\d{10})\\s*/\\s*(${NG_BANK})`,
  "i",
);

/** True when the narration is a person payout through a wallet brand, not an airtime purchase. */
export function isPersonWalletTransfer(description: string): boolean {
  const d = description.replace(/\s+/g, " ");
  if (PERSON_MOMO.test(d) || NG_ACCOUNT.test(d)) return true;
  // "NAME / +233… / MTN" already covered; also "Money transfer to NAME / phone / MTN".
  return /\/\s*\+?\d{8,15}\s*\/\s*(mtn|vodafone|airteltigo|airtel ?tigo|m-?pesa|orange)/i.test(d)
    || /\/\s*\d{10}\s*\/\s*(guaranty|gtbank|opay|moniepoint|first\s*bank|stanbic)/i.test(d);
}

/** Label from stored fields: "Sent to Ghana (mobile money)". */
export function destinationLabelFor(country?: string | null, currency?: string | null): string | undefined {
  if (!country) return undefined;
  const momo = currency === "GHS" || currency === "XOF" || currency === "KES" || country === "Ghana" || country === "Benin" || country === "Kenya";
  return momo && country !== "Nigeria" ? `Sent to ${country} (mobile money)` : `Sent to ${country}`;
}

export function inferDestination(description: string): DestinationHint | undefined {
  const d = description.replace(/\s+/g, " ").trim();
  const momo = d.match(PERSON_MOMO);
  if (momo) {
    const dial = DIAL.find((x) => momo[2].startsWith(x.code));
    if (dial) {
      const personName = titleName(momo[1].replace(/^money transfer to\s+/i, ""));
      return {
        country: dial.country,
        countryCode: dial.countryCode,
        currency: dial.currency,
        channel: "mobile_money",
        label: labelFor(dial.country, "mobile_money"),
        confidence: 0.4,
        personName,
        isPersonTransfer: true,
      };
    }
  }
  const bank = d.match(NG_ACCOUNT);
  if (bank) {
    const personName = titleName(bank[1].replace(/^money transfer to\s+/i, ""));
    return {
      country: "Nigeria",
      countryCode: "NG",
      currency: "NGN",
      channel: "bank",
      label: labelFor("Nigeria", "bank"),
      confidence: 0.4,
      personName,
      isPersonTransfer: true,
    };
  }
  const bare = d.match(BARE_DIAL);
  if (bare) {
    const dial = DIAL.find((x) => x.code === bare[1]);
    if (dial) {
      return {
        country: dial.country,
        countryCode: dial.countryCode,
        currency: dial.currency,
        channel: dial.countryCode === "NG" ? "bank" : "mobile_money",
        label: labelFor(dial.country, dial.countryCode === "NG" ? "bank" : "mobile_money"),
        confidence: 0.35,
        isPersonTransfer: isPersonWalletTransfer(d),
      };
    }
  }
  return undefined;
}
