/** Type-to-confirm: exact, case-sensitive match after trimming the typed text. */
export function confirmMatches(typed: string, name: string): boolean {
  return name !== "" && typed.trim() === name;
}
