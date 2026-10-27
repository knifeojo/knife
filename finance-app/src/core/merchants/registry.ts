// A hook for looking up registered businesses (for example a company registry) by the name a bank
// wrote, for payees the rules and the merchant directory do not know. Nothing is wired to a real
// registry yet: the default lookup answers nothing, so behaviour is unchanged until one is added.

export interface RegistryResult {
  /** The registered name, e.g. "Acme Stitches Limited". */
  name: string;
  category: string;
  subcategory?: string | null;
  /** 0 to 1. */
  confidence: number;
}

export interface BusinessRegistry {
  lookup(name: string): Promise<RegistryResult | undefined>;
}

/** Names a registry could know: they end in a Nigerian legal form ("… LTD", "… VENTURES", "… NIG"). */
const REGISTERED = /\b(ltd|limited|enterprises?|ventures?|nig(?:eria)?)\.?\s*$/i;

export function isRegistryCandidate(name: string | null | undefined): boolean {
  return !!name && /[a-z]{2,}/i.test(name.replace(REGISTERED, "")) && REGISTERED.test(name.trim());
}

export const NO_REGISTRY: BusinessRegistry = {
  async lookup() {
    return undefined;
  },
};
