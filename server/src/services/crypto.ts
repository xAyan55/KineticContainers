import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDatabasePath } from "../db.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

export function resolveKeyFilePath(): string {
  if (process.env.KCT_ENCRYPTION_KEY_PATH) {
    return path.resolve(process.env.KCT_ENCRYPTION_KEY_PATH);
  }
  const dbPath = resolveDatabasePath();
  return path.join(path.dirname(dbPath), "encryption.key");
}

/**
 * Returns the persistent 256-bit encryption key.
 * Never silently regenerates an existing unreadable key.
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.KCT_ENCRYPTION_KEY?.trim();
  if (envKey) {
    if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
      cachedKey = Buffer.from(envKey, "hex");
      return cachedKey;
    }
    if (Buffer.from(envKey, "base64").length === 32) {
      cachedKey = Buffer.from(envKey, "base64");
      return cachedKey;
    }
    throw new Error(
      "KCT_ENCRYPTION_KEY environment variable must be a 64-character hex string or 32-byte base64 string."
    );
  }

  const keyPath = resolveKeyFilePath();
  if (fs.existsSync(keyPath)) {
    try {
      const raw = fs.readFileSync(keyPath);
      if (raw.length === 32) {
        cachedKey = raw;
        return cachedKey;
      }
      const text = raw.toString("utf8").trim();
      if (text.length === 64 && /^[0-9a-fA-F]+$/.test(text)) {
        cachedKey = Buffer.from(text, "hex");
        return cachedKey;
      }
      throw new Error(`Encryption key file at ${keyPath} has invalid size (${raw.length} bytes; expected 32 bytes or 64 hex chars).`);
    } catch (err) {
      throw new Error(
        `Failed to read persistent encryption key from ${keyPath}: ${err instanceof Error ? err.message : String(err)}. Refusing to overwrite existing key.`
      );
    }
  }

  // Key file does not exist yet: generate and persist with restrictive permissions.
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const fresh = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, fresh, { mode: 0o600 });
  } catch (err) {
    throw new Error(`Failed to initialize encryption key at ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  cachedKey = fresh;
  return cachedKey;
}

export function setMasterKeyForTests(key: Buffer | null): void {
  cachedKey = key;
}

/**
 * Encrypt a string using AES-256-GCM.
 * Output format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plainText: string): string {
  if (!plainText) return "";
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypt a string encrypted with encryptSecret.
 * If the input is not prefixed with enc:v1:, it is returned as-is (safe for legacy/empty values).
 */
export function decryptSecret(cipherText: string | null | undefined): string {
  if (!cipherText) return "";
  if (!cipherText.startsWith(PREFIX)) {
    return cipherText;
  }
  const payload = cipherText.slice(PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format.");
  }
  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Generate a cryptographically secure, high-entropy node credential.
 */
export function generateNodeCredential(): string {
  return `kct_node_sec_${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Generate a cryptographically secure one-time enrollment token.
 */
export function generateEnrollmentToken(): string {
  return `kct_enroll_${crypto.randomBytes(24).toString("hex")}`;
}

/**
 * Constant-time comparison of two strings.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Prevent timing leaks on length by doing dummy compare then returning false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const B64_CHARS = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function b64From24Bit(b2: number, b1: number, b0: number, size: number): string {
  let v = (b2 << 16) | (b1 << 8) | b0;
  let out = "";
  while (size-- > 0) {
    out += B64_CHARS[v & 0x3f];
    v >>= 6;
  }
  return out;
}

/**
 * Standard Drepper SHA-512 crypt ($6$) implementation conforming to glibc crypt(3)
 * and OpenSSL 'passwd -6'. Compatible across all Linux distributions (/etc/shadow).
 */
export function sha512Crypt(key: string, salt?: string, rounds = 5000): string {
  const cleanSalt = (
    salt ||
    crypto.randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)
  ).slice(0, 16);
  const keyBuf = Buffer.from(key, "utf8");
  const saltBuf = Buffer.from(cleanSalt, "utf8");

  // Digest B
  const ctxB = crypto.createHash("sha512");
  ctxB.update(keyBuf);
  ctxB.update(saltBuf);
  ctxB.update(keyBuf);
  const altResult = ctxB.digest();

  // Digest A
  const ctxA = crypto.createHash("sha512");
  ctxA.update(keyBuf);
  ctxA.update(saltBuf);

  let cnt = keyBuf.length;
  while (cnt > 64) {
    ctxA.update(altResult);
    cnt -= 64;
  }
  ctxA.update(altResult.subarray(0, cnt));

  cnt = keyBuf.length;
  while (cnt > 0) {
    if ((cnt & 1) !== 0) {
      ctxA.update(altResult);
    } else {
      ctxA.update(keyBuf);
    }
    cnt >>= 1;
  }
  let pResult = ctxA.digest();

  // P sequence
  const ctxP = crypto.createHash("sha512");
  for (let i = 0; i < keyBuf.length; i++) ctxP.update(keyBuf);
  const pBytes = ctxP.digest();
  const pSeq = Buffer.alloc(keyBuf.length);
  for (let i = 0; i < keyBuf.length; i++) pSeq[i] = pBytes[i % 64];

  // S sequence
  const ctxS = crypto.createHash("sha512");
  for (let i = 0; i < 16 + pResult[0]; i++) ctxS.update(saltBuf);
  const sBytes = ctxS.digest();
  const sSeq = Buffer.alloc(cleanSalt.length);
  for (let i = 0; i < cleanSalt.length; i++) sSeq[i] = sBytes[i % 64];

  // 5000 rounds
  for (let i = 0; i < rounds; i++) {
    const ctx = crypto.createHash("sha512");
    if ((i & 1) !== 0) ctx.update(pSeq);
    else ctx.update(pResult);

    if (i % 3 !== 0) ctx.update(sSeq);
    if (i % 7 !== 0) ctx.update(pSeq);

    if ((i & 1) !== 0) ctx.update(pResult);
    else ctx.update(pSeq);

    pResult = ctx.digest();
  }

  // Final base64 encoding matching glibc / shadow
  let encoded = "";
  encoded += b64From24Bit(pResult[0], pResult[21], pResult[42], 4);
  encoded += b64From24Bit(pResult[22], pResult[43], pResult[1], 4);
  encoded += b64From24Bit(pResult[44], pResult[2], pResult[23], 4);
  encoded += b64From24Bit(pResult[3], pResult[24], pResult[45], 4);
  encoded += b64From24Bit(pResult[25], pResult[46], pResult[4], 4);
  encoded += b64From24Bit(pResult[47], pResult[5], pResult[26], 4);
  encoded += b64From24Bit(pResult[6], pResult[27], pResult[48], 4);
  encoded += b64From24Bit(pResult[28], pResult[49], pResult[7], 4);
  encoded += b64From24Bit(pResult[50], pResult[8], pResult[29], 4);
  encoded += b64From24Bit(pResult[9], pResult[30], pResult[51], 4);
  encoded += b64From24Bit(pResult[31], pResult[52], pResult[10], 4);
  encoded += b64From24Bit(pResult[53], pResult[11], pResult[32], 4);
  encoded += b64From24Bit(pResult[12], pResult[33], pResult[54], 4);
  encoded += b64From24Bit(pResult[34], pResult[55], pResult[13], 4);
  encoded += b64From24Bit(pResult[56], pResult[14], pResult[35], 4);
  encoded += b64From24Bit(pResult[15], pResult[36], pResult[57], 4);
  encoded += b64From24Bit(pResult[37], pResult[58], pResult[16], 4);
  encoded += b64From24Bit(pResult[59], pResult[17], pResult[38], 4);
  encoded += b64From24Bit(pResult[18], pResult[39], pResult[60], 4);
  encoded += b64From24Bit(pResult[40], pResult[61], pResult[19], 4);
  encoded += b64From24Bit(pResult[62], pResult[20], pResult[41], 4);
  encoded += b64From24Bit(0, 0, pResult[63], 2);

  return `$6$${cleanSalt}$${encoded}`;
}
