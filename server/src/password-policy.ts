export const BCRYPT_MAX_PASSWORD_BYTES = 72;
/** bcrypt truncates passwords after 72 UTF-8 bytes. */
export function passwordWithinBcryptLimit(password: string): boolean {
  return Buffer.byteLength(password, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES;
}
