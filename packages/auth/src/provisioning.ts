import { randomInt } from 'node:crypto';

/**
 * Generating the credentials a provisioned admin receives.
 *
 * Both halves matter: a username that is predictable is a minor nuisance, but a
 * temporary password that is predictable is a full account takeover, because it is a
 * live credential for an Admin from the moment it is created until the email is read.
 */

/**
 * The alphabet a temporary password is drawn from.
 *
 * `l`, `I`, `1`, `O` and `0` are left out: this password is read off a screen and typed
 * by hand exactly once, and a character that cannot be told apart from another turns a
 * successful purchase into a support ticket. The remaining set still gives roughly 6
 * bits per character, so a 16-character password carries about 96 bits of entropy.
 */
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*?';
const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

export const TEMPORARY_PASSWORD_LENGTH = 16;

/**
 * A cryptographically random temporary password.
 *
 * `crypto.randomInt` is used rather than `Math.random`, which is seeded pseudo-randomness
 * an attacker can reconstruct from a few outputs. The draw is rejection-sampled by Node
 * so every character is uniform - a modulo of a random byte would quietly favour the
 * start of the alphabet.
 *
 * One character from each class is placed first and then the whole thing is shuffled,
 * so the result always satisfies a four-class policy without the shuffle leaking where
 * the guaranteed characters landed.
 */
export function generateTemporaryPassword(
  length: number = TEMPORARY_PASSWORD_LENGTH,
): string {
  if (!Number.isSafeInteger(length) || length < 12)
    throw new Error('Temporary passwords must be at least 12 characters');

  const characters = [
    LOWER[randomInt(LOWER.length)]!,
    UPPER[randomInt(UPPER.length)]!,
    DIGITS[randomInt(DIGITS.length)]!,
    SYMBOLS[randomInt(SYMBOLS.length)]!,
  ];
  while (characters.length < length)
    characters.push(ALPHABET[randomInt(ALPHABET.length)]!);

  // Fisher-Yates with a cryptographic source; a `sort(() => Math.random() - 0.5)`
  // shuffle is famously not uniform and would bias where the class characters sit.
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [characters[index], characters[swap]] = [
      characters[swap]!,
      characters[index]!,
    ];
  }
  return characters.join('');
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function isValidUsername(value: unknown): value is string {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

/**
 * Turns a name or an email local-part into a username candidate.
 *
 * Diacritics are folded rather than stripped so `José Pérez` becomes `jose.perez` and
 * not `jos.prez`, which would be both wrong and hard to say over the phone.
 */
export function usernameCandidate(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-_]+|[.\-_]+$/g, '')
    .slice(0, 32);
  // Anything that reduces to nothing usable falls back to a generic stem, which the
  // uniqueness loop below will then number.
  return base.length >= 3 ? base : 'admin';
}

/**
 * Finds a free username near the candidate.
 *
 * Suffixes are random rather than sequential (`johnsmith42`, not `johnsmith2`): a
 * sequential suffix tells anyone who can see one username how many accounts exist and
 * lets them guess the next, which is free reconnaissance for a login-guessing attempt.
 */
export async function allocateUsername(
  preferred: string,
  isTaken: (username: string) => Promise<boolean>,
  attempts = 25,
): Promise<string> {
  const base = usernameCandidate(preferred);
  if (isValidUsername(base) && !(await isTaken(base))) return base;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const suffix = randomInt(10, attempt < 10 ? 100 : 100000);
    const candidate = `${base.slice(0, 32 - String(suffix).length)}${suffix}`;
    if (isValidUsername(candidate) && !(await isTaken(candidate)))
      return candidate;
  }
  throw new Error('Could not allocate a unique username');
}
