/** Reject malformed armor IDs before a native grant can create an unremovable
 * inventory entry. This checks the encoding; content availability is separate. */
export function validArmorId(id: number): boolean {
  return Number.isInteger(id) && id >= 0x0c100000 && id < 0x0c600000;
}

/** Native part codes: head, chest, arms, waist, legs. Series uses the low 20 bits. */
export function armorId(series: number, part: 1 | 2 | 3 | 4 | 5): number {
  return 0x0c000000 + part * 0x100000 + series;
}
