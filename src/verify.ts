import { createHmac, timingSafeEqual } from "crypto";
import { WEBHOOK_SECRET } from "./config.ts";

export function verifySignature(payload: string, signature: string | null): boolean {
  if (!signature) return false;

  const expected = "sha256=" +
    createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}
