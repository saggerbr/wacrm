import crypto from 'crypto'

const IV_LENGTH = 16
const EXPECTED_KEY_HEX_LENGTH = 64 // 32 bytes for AES-256

/**
 * Validate and return the ENCRYPTION_KEY. Throws with an actionable
 * message if the env var is missing or malformed. Deliberately lazy
 * (called at first use) instead of at module import so Next.js build
 * doesn't blow up when env vars aren't injected (e.g. during
 * `next build` on a fresh CI runner).
 */
function getEncryptionKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY
  if (!value) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      'ENCRYPTION_KEY must be a hex string (0-9, a-f). Got non-hex characters.'
    )
  }
  if (value.length !== EXPECTED_KEY_HEX_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly ${EXPECTED_KEY_HEX_LENGTH} hex chars (32 bytes for AES-256). ` +
        `Got ${value.length} chars.`
    )
  }
  return Buffer.from(value, 'hex')
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':')
  if (parts.length !== 2) {
    throw new Error(
      'Encrypted token has invalid format (expected "iv:ciphertext"). ' +
        'This usually means the stored value is corrupt or was encrypted with a different key.'
    )
  }
  const iv = Buffer.from(parts[0], 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(), iv)
  let decrypted = decipher.update(parts[1], 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
