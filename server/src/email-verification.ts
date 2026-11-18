import crypto from 'node:crypto';

export function generateEmailCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashEmailCode(secret: string, userId: string, code: string) {
  return crypto.createHmac('sha256', secret)
    .update(`relay-email-verification:${userId}:${code}`)
    .digest('hex');
}

export function matchesEmailCode(secret: string, userId: string, code: string, storedHash: string) {
  const expected = Buffer.from(hashEmailCode(secret, userId, code), 'hex');
  const actual = Buffer.from(storedHash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
