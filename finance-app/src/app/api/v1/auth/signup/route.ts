import { signupWithPassword } from "@/lib/mobile/password-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return signupWithPassword(req);
}
