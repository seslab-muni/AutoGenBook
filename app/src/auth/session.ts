/**
 * Auth is not designed yet (lands in #16 onward). This is the single place
 * the API client asks for credentials, so wiring up real auth later touches
 * only this file.
 */
export function getAuthHeaders(): Record<string, string> {
  return {};
}
