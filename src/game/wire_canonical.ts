import { rejson } from "./sdk";

export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return rejson.dump_string(value, -1);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${canonical(k)}:${canonical(obj[k])}`).join(",")}}`;
}
