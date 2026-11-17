import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function encryptionKey(secret = process.env.KEY_ENCRYPTION_SECRET) {
  if (!secret || secret.length < 32)
    throw new Error("KEY_ENCRYPTION_SECRET 必须至少 32 字符。");
  return createHash("sha256").update(secret).digest();
}
export function encryptKey(plain: string, userId: string, secret?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(userId));
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function decryptKey(value: string, userId: string, secret?: string) {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted)
    throw new Error("密钥数据无效。");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
export function contentHash(title: string, answer: string) {
  return createHash("sha256")
    .update(
      title.trim().replace(/\s+/g, " ") +
        "\n" +
        answer.trim().replace(/\r\n/g, "\n"),
    )
    .digest("hex");
}
