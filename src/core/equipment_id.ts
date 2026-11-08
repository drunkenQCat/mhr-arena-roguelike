/** Reject malformed armor IDs before a native grant can create an unremovable
 * inventory entry. This checks the encoding; content availability is separate. */
export function validArmorId(id: number): boolean {
  return Number.isInteger(id) && id >= 0x0c100000 && id < 0x0c600000;
}
