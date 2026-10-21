import { z } from "zod";

// Shared by the web forms and the mobile JSON API so the rules cannot drift.
export const credentials = z.object({
  email: z.string().trim().toLowerCase().max(254, "Enter a valid email").email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(80).optional(),
});

export const loginCredentials = credentials.omit({ name: true });
