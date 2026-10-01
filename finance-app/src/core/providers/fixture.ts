import { SAMPLE_INBOX } from "../fixtures/gtbank-alerts";
import type { EmailMessage } from "../types";
import type { EmailSource } from "./types";

/** In-memory inbox used by tests and the "Import sample alerts" button. Ignores the query. */
export class FixtureEmailSource implements EmailSource {
  readonly source = "fixture" as const;
  constructor(private readonly messages: EmailMessage[] = SAMPLE_INBOX) {}

  async listMessageIds({ after }: { after?: Date }) {
    return this.messages.filter((m) => !after || m.date >= after).map((m) => m.id);
  }

  async getMessage(id: string) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error(`fixture ${id} not found`);
    return m;
  }
}
