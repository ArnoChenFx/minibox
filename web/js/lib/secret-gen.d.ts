/** The source of random bytes: the Web Crypto API, or a stand-in in tests. */
export interface RandomSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

/** A new secret value: 43 URL-safe base64 characters, from 32 random bytes. */
export declare function generateSecret(random?: RandomSource): string;
