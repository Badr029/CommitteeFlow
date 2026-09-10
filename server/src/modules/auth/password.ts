import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (spec §39).
 *
 * Argon2id with OWASP's baseline parameters: 19 MiB memory, 2 iterations,
 * 1 degree of parallelism. Argon2 embeds the salt and every parameter in the
 * encoded hash, so verification stays correct if these values are raised later.
 */
const HASH_OPTIONS = {
  // Argon2id is @node-rs/argon2's default; naming it here would require
  // importing an ambient const enum, which `verbatimModuleSyntax` forbids.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Rejected before hashing so a huge input cannot become a CPU denial of service. */
export const MAX_PASSWORD_BYTES = 256;

export async function hashPassword(plaintext: string): Promise<string> {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error(`password exceeds ${MAX_PASSWORD_BYTES} bytes`);
  }
  return hash(plaintext, HASH_OPTIONS);
}

export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PASSWORD_BYTES) {
    return false;
  }
  try {
    return await verify(storedHash, plaintext);
  } catch {
    // A malformed stored hash must read as "wrong password", not as a 500.
    return false;
  }
}

/**
 * Burns roughly the same CPU as a real verification.
 *
 * Called when the submitted email matches no account, so response timing does
 * not reveal which addresses exist.
 */
export async function fakeVerify(): Promise<void> {
  await hash('committeeflow-timing-equaliser', HASH_OPTIONS);
}
