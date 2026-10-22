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
