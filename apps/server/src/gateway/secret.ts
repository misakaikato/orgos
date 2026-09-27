/**
 * 厂商 key 的加密存放：AES-256-GCM，数据密钥由 ORGOS_SECRET 经 HKDF-SHA256 派生。
 *
 * - 没有 ORGOS_SECRET 时：开发模式（ORGOS_DEV=1）用仓库里写明的本地默认值；非开发模式拒绝启动
 *   （`assertSecretConfigured` 在进程入口调用）。换了 ORGOS_SECRET，已存的 key 解不开，需要重填。
 * - 密文格式：`v1.<iv>.<tag>.<ciphertext>`（base64url）。
 */
import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { isDevMode } from "@/env";

/** 仅限本地开发的默认值（README 注明）；任何对外部署都必须设置 ORGOS_SECRET。 */
export const DEV_SECRET = "orgos-local-dev-secret-not-for-deploy";

const VERSION = "v1";

function secret(): string {
	const configured = process.env.ORGOS_SECRET;
	if (configured) return configured;
	if (isDevMode()) return DEV_SECRET;
	throw new Error("ORGOS_SECRET 未设置：非开发模式必须设置它才能存取厂商 key");
}

/** 进程入口调用：非开发模式下没有 ORGOS_SECRET 直接失败退出。 */
export function assertSecretConfigured(): void {
	secret();
}

function dataKey(): Buffer {
	return Buffer.from(
		hkdfSync("sha256", secret(), "orgos", "model-provider-key", 32),
	);
}

export function encryptSecret(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
	const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv, tag, body]
		.map((p) => (typeof p === "string" ? p : p.toString("base64url")))
		.join(".");
}

export function decryptSecret(sealed: string): string {
	const [version, iv, tag, body] = sealed.split(".");
	if (version !== VERSION || !iv || !tag || body === undefined)
		throw new Error("密文格式不对");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		dataKey(),
		Buffer.from(iv, "base64url"),
	);
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(body, "base64url")),
		decipher.final(),
	]).toString("utf8");
}
