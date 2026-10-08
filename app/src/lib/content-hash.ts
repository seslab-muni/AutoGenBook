/**
 * sha256 (lowercase hex) of the UTF-8 bytes of `text` - the API's `contentHash` of a section.
 * Used only where the server did not hand its own hash over (a node from a list, a mock); `null`
 * where the Web Crypto API is missing (an insecure origin), so callers can send no hash at all
 * rather than a wrong one.
 */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    return null;
  }
}
