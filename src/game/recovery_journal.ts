import { refFs, rejson } from "./sdk";

/** Missing files are the only empty state. Truncated/unreadable journals block
 * new mutations, so a new run cannot replace the only original inventory copy. */
export function readRecoveryRecord<T extends { active: boolean }>(file: string): T | null {
  const text = refFs.read(file);
  if (text === "" && !refFs.glob(file.split(".").join("\\.")).includes(file)) return null;
  const raw = rejson.load_string(text) as T | null;
  if (!raw || typeof raw !== "object" || typeof raw.active !== "boolean")
    throw new Error(`恢复记录损坏或不可读：${file}；保留文件，禁止覆盖备份`);
  return raw;
}

export function recoveryPending(file: string): boolean {
  try { return readRecoveryRecord(file)?.active === true; }
  catch { return true; }
}
