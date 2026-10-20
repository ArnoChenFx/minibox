/** Crockford base32, the alphabet ULIDs are written in. It sorts in the same order as the bytes it encodes. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
const RANDOM_CHARS = 16;

function encodeTime(time: number): string {
  let out = "";
  let rest = time;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = ALPHABET.charAt(Number(bits & 31n)) + out;
    bits >>= 5n;
  }
  return out;
}

/** Adds one to the random part, treating it as a big-endian integer. Returns `false` when it would wrap around. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const next = (bytes[i] ?? 0) + 1;
    if (next <= 0xff) {
      bytes[i] = next;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

/**
 * A generator of ULIDs: 48 bits of millisecond time followed by 80 random bits, in 26 characters. Ids from one
 * generator are strictly increasing even when several are made in the same millisecond or the clock steps back,
 * so sorting by id is sorting by creation. Ids from different generators are not ordered against each other.
 */
export function createUlid(): (now?: number) => string {
  let lastTime = -1;
  const lastRandom = new Uint8Array(RANDOM_BYTES);
  return (now = Date.now()) => {
    if (now > lastTime) {
      lastTime = now;
      crypto.getRandomValues(lastRandom);
    } else if (!increment(lastRandom)) {
      lastTime += 1;
      crypto.getRandomValues(lastRandom);
    }
    return encodeTime(lastTime) + encodeRandom(lastRandom);
  };
}

/** The process-wide generator used for event ids. */
export const ulid = createUlid();
