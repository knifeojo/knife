import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

/**
 * Email / SMS stubs for banks we have not seen a real sample of.
 * Do not invent formats. Real samples will replace these in a follow-up.
 * Tests assert each stub is registered and never claims a match.
 */
class StubParser implements AlertParser {
  readonly stub = true;
  readonly channels: readonly ("email" | "sms")[];
  constructor(
    readonly name: string,
    readonly institution: string,
    readonly senders: readonly string[],
    channels: readonly ("email" | "sms")[],
  ) {
    this.channels = channels;
  }
  canParse(_msg: AlertMessage): boolean {
    return false;
  }
  parse(_msg: AlertMessage): ParsedAlert | null {
    return null;
  }
}

export const STUB_PARSERS: AlertParser[] = [
  // TODO: First Bank email — real sample not yet supplied.
  new StubParser("FirstBankEmailParser", "First Bank", ["firstbanknigeria.com", "firstbank.com"], ["email"]),
  // TODO: Sterling Bank email — real sample not yet supplied.
  new StubParser("SterlingEmailParser", "Sterling Bank", ["sterling.ng", "sterlingbankng.com"], ["email"]),
  // TODO: GTBank SMS from the GT World app sender (distinct from 'GTBank').
  new StubParser("GTWorldSmsParser", "GTBank", ["GTWorld"], ["sms"]),
  // TODO: SMS formats for other Nigerian banks once samples arrive.
  new StubParser("AccessSmsParser", "Access Bank", ["AccessBank", "ACCESS"], ["sms"]),
  new StubParser("ZenithSmsParser", "Zenith Bank", ["ZenithBank", "ZENITH"], ["sms"]),
  new StubParser("UbaSmsParser", "UBA", ["UBA"], ["sms"]),
];
