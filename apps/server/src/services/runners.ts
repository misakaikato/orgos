/**
 * 设备：配对、列表、吊销、上下线。配对码与 token 在库里只存 SHA-256 哈希。
 *
 * 在线状态以 `runners.status` 为准：Runner 发来 hello 置 online，当前连接断开置 offline，
 * 服务进程启动时全部置 offline（见 serve.ts）。每次变化推 `{t:'runner'}` 给设备主人。
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CapabilitySchema,
	type CreatePairingCodeResponse,
	ERROR_CODES,
	normalizePairingCode,
	PAIRING_CODE_ALPHABET,
	PAIRING_CODE_GROUP_LENGTH,
	PAIRING_CODE_GROUPS,
	PAIRING_CODE_RE,
	PAIRING_CODE_TTL_MS,
	type PairRunnerRequest,
	type PairRunnerResponse,
	RUNNER_WS_CLOSE,
	type Runner,
	type RunnerUp,
} from "@orgos/protocol";
import { asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { agents, pairingCodes, runners } from "@/db/schema";
import {
	consumePairingCode,
	type PrincipalRow,
	type RunnerRow,
	type Scoped,
	scoped,
} from "@/db/scope";
import { AppError, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/uuid";
import { browserHub } from "@/realtime/browser-hub";
import { runnerHub } from "@/realtime/runner-hub";

/** 服务端所在仓库的根目录（设备页给出的 Runner 命令在这里运行）。 */
export const REPO_DIR = path.resolve(
	fileURLToPath(new URL("../../../../", import.meta.url)),
);

export function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** 均匀随机取字母表中的字符（拒绝采样，避免取模偏差）。 */
function randomChars(count: number): string {
	const n = PAIRING_CODE_ALPHABET.length;
	const limit = 256 - (256 % n);
	let out = "";
	while (out.length < count) {
		for (const b of randomBytes(count * 2)) {
			if (b >= limit) continue;
			out += PAIRING_CODE_ALPHABET[b % n];
			if (out.length === count) break;
		}
	}
	return out;
}

export function generatePairingCode(): string {
	return normalizePairingCode(
		randomChars(PAIRING_CODE_GROUPS * PAIRING_CODE_GROUP_LENGTH),
	);
}

function generateToken(): string {
	return `ort_${randomBytes(32).toString("base64url")}`;
}

const CapabilitiesSchema = z.array(CapabilitySchema).catch([]);

export function toRunner(row: RunnerRow): Runner {
	return {
		id: row.id,
		ownerId: row.ownerId,
		name: row.name,
		os: row.os,
		workspace: row.workspace,
		capabilities: CapabilitiesSchema.parse(row.capabilities),
		status: row.status,
		lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		...(row.revokedAt ? { revoked: true } : {}),
		...(row.via ? { via: row.via } : {}),
	};
}

/** 把设备的变化推给它的主人。 */
function notifyRunner(row: RunnerRow): void {
	browserHub.sendTo([row.ownerId], { t: "runner", runner: toRunner(row) });
}

/** 生成一个 10 分钟有效、一次性的配对码。 */
export async function createPairingCode(
	s: Scoped,
	ownerId: string,
	now = new Date(),
): Promise<CreatePairingCodeResponse> {
	const code = generatePairingCode();
	const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
	await s.insert(pairingCodes, {
		codeHash: hashSecret(code),
		ownerId,
		expiresAt,
	});
	return { code, expiresAt: expiresAt.toISOString(), repoDir: REPO_DIR };
}

function pairingCodeInvalid(): AppError {
	return new AppError(
		400,
		ERROR_CODES.PAIRING_CODE_INVALID,
		"配对码无效、已过期或已被使用",
	);
}

/** 凭配对码登记一台设备，返回它的 token（只在此刻出现一次）。 */
export async function pairRunner(
	req: PairRunnerRequest,
	now = new Date(),
): Promise<PairRunnerResponse> {
	const code = normalizePairingCode(req.code);
	if (!PAIRING_CODE_RE.test(code)) throw pairingCodeInvalid();
	const used = await consumePairingCode(hashSecret(code), now);
	if (!used) throw pairingCodeInvalid();
	const token = generateToken();
	const row = await scoped(used.tenantId).insert(runners, {
		ownerId: used.ownerId,
		name: req.name,
		os: req.os,
		tokenHash: hashSecret(token),
		capabilities: [],
		status: "offline",
		via: req.via ?? null,
	});
	notifyRunner(row);
	return { runnerId: row.id, token };
}

/** 我的设备（不含已吊销的），按配对时间。 */
export async function listRunners(
	s: Scoped,
	ownerId: string,
): Promise<Runner[]> {
	const rows = await s.executor
		.select()
		.from(runners)
		.where(
			s.where(runners, eq(runners.ownerId, ownerId), isNull(runners.revokedAt)),
		)
		.orderBy(asc(runners.createdAt));
	return rows.map(toRunner);
}

/** 本人的一台未吊销设备；不存在、已吊销、跨租户或别人的 → 404。 */
export async function requireOwnRunner(
	s: Scoped,
	me: Pick<PrincipalRow, "id">,
	runnerId: string,
): Promise<RunnerRow> {
	const row = isUuid(runnerId)
		? await s.first(
				runners,
				eq(runners.id, runnerId),
				eq(runners.ownerId, me.id),
				isNull(runners.revokedAt),
			)
		: undefined;
	if (!row) throw notFound("设备不存在");
	return row;
}

/**
 * 吊销：token 立即失效，绑定它的助手一并解绑，在线连接以 4003 关闭。
 * 外部助手保留绑定（它离不开这台设备），此后它的任务一律失败。
 */
export async function revokeRunner(
	s: Scoped,
	me: PrincipalRow,
	runnerId: string,
): Promise<void> {
	const row = await requireOwnRunner(s, me, runnerId);
	const revoked = await s.transaction(async (tx) => {
		await tx.executor
			.update(agents)
			.set({ runnerId: null })
			.where(
				tx.where(
					agents,
					eq(agents.runnerId, row.id),
					eq(agents.engine, "builtin"),
				),
			);
		const [updated] = await tx.executor
			.update(runners)
			.set({ revokedAt: new Date(), status: "offline" })
			.where(tx.where(runners, eq(runners.id, row.id)))
			.returning();
		return updated;
	});
	runnerHub.kick(row.id, RUNNER_WS_CLOSE.REVOKED, "revoked");
	if (revoked) notifyRunner(revoked);
}

/** Runner 连上并发来 hello：记下它声明的系统、工作目录与能力，置为在线。 */
export async function markRunnerOnline(
	runner: RunnerRow,
	hello: Extract<RunnerUp, { t: "hello" }>,
): Promise<boolean> {
	const s = scoped(runner.tenantId);
	const [row] = await s.executor
		.update(runners)
		.set({
			os: hello.os,
			workspace: hello.workspace,
			capabilities: hello.capabilities,
			status: "online",
			lastSeenAt: new Date(),
		})
		.where(
			s.where(runners, eq(runners.id, runner.id), isNull(runners.revokedAt)),
		)
		.returning();
	if (row) notifyRunner(row);
	return row !== undefined;
}

/** Runner 更新了它的能力（适配器探测完成）。 */
export async function updateRunnerCapabilities(
	runner: RunnerRow,
	capabilities: Extract<RunnerUp, { t: "capabilities" }>["capabilities"],
): Promise<void> {
	const s = scoped(runner.tenantId);
	const [row] = await s.executor
		.update(runners)
		.set({ capabilities, lastSeenAt: new Date() })
		.where(
			s.where(runners, eq(runners.id, runner.id), isNull(runners.revokedAt)),
		)
		.returning();
	if (row) notifyRunner(row);
}

/** 设备的当前连接断开：置为离线并记下最后在线时间。 */
export async function markRunnerOffline(runner: RunnerRow): Promise<void> {
	const s = scoped(runner.tenantId);
	const [row] = await s.executor
		.update(runners)
		.set({ status: "offline", lastSeenAt: new Date() })
		.where(
			s.where(runners, eq(runners.id, runner.id), isNull(runners.revokedAt)),
		)
		.returning();
	if (row) notifyRunner(row);
}
