/**
 * A new value for the add-secret form: 32 random bytes as URL-safe base64 without padding, which is 43 characters.
 * `random` is the Web Crypto source; the tests pass their own. Pure, so the value is never logged or stored here.
 */
export function generateSecret(random = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
