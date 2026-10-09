import { createAvatar } from "@dicebear/core";
import { lorelei } from "@dicebear/collection";

/** Deterministic Lorelei avatar; seed is the account identity, never a fictional name. */
export function avatarDataUri(seed: string): string {
  const safe = seed.trim() || "kineticct";
  return createAvatar(lorelei, {
    seed: safe,
    backgroundColor: ["101010", "202020"],
  }).toDataUri();
}
