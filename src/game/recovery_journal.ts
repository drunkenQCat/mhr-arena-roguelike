import { loadWebconsole, refFs, rejson } from "./sdk";
let lastWriteFailure: string | null = null;
export function recoveryWriteFailure(): string | null { return lastWriteFailure; }

/** A missing/newer DLL must fail before inventory mutation, never fall back to
 * overwriting the sole original journal through json.dump_file. */
export function writeRecoveryRecord<T extends { active: boolean }>(file: string, value: T): boolean {
  lastWriteFailure=null;
  try {
    const write = loadWebconsole().write_recovery;
    if (!write) throw new Error("原装备备份写入器不可用：请完整更新发行包并重启游戏（webconsole DLL 不匹配）");
    const text = rejson.dump_string(value, -1);
    if (write(file, text)!==true) throw new Error("Recovery file publication failed; original record retained");
    if (refFs.read(file)!==text) throw new Error("Recovery write readback mismatch; do not retry inventory mutation");
    return true;
  } catch (error) { lastWriteFailure=String(error);return false; }
}

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
