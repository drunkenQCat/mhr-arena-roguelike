import { canonical } from "./wire_canonical";
import { persistStartupState, startupCommitRecord } from "./equip_wear";
import { pouchCommitRecord, retirePouchCommit } from "./pouch_backup";

/** Certification refers to these exact journals and the verified live contents.
 * Native save success alone must never retire a later run's recovery record. */
export function captureRecoveryCommit(): string | null {
  const equipment=startupCommitRecord(), pouch=pouchCommitRecord();
  if (equipment===undefined || pouch===undefined || !equipment && !pouch) return null;
  if (equipment?.pouchIsolated && !pouch) return null;
  return canonical({equipment,pouch});
}

export function commitRecovery(token: string): void {
  if (captureRecoveryCommit()!==token) throw new Error("Recovery changed while native saving; original journals retained");
  if (!persistStartupState(null)) throw new Error("Cannot retire saved equipment recovery");
  // Retire the referencing journal first. If the second write fails, the pouch
  // remains independently recoverable; the reverse order loses its required link.
  if (!retirePouchCommit()) throw new Error("Cannot retire saved pouch recovery");
}
