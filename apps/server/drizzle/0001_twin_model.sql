-- 分身模型：人的在线状态；代理改名（幕僚长 → 分身、执行助理 → 执行助手，handle 后缀 -chief → -twin）；
-- 找别人代理的旁路私聊并入两人私聊；两个真人的私聊补上双方分身。每条语句都可重复执行。
ALTER TABLE "principals" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'available' NOT NULL;
--> statement-breakpoint
UPDATE "principals" AS p
SET "handle" = regexp_replace(p."handle", '-chief$', '-twin')
WHERE p."kind" = 'agent'
	AND p."handle" LIKE '%-chief'
	AND EXISTS (
		SELECT 1 FROM "agents" AS a
		WHERE a."principal_id" = p."id" AND a."role" = 'front'
	)
	AND NOT EXISTS (
		SELECT 1 FROM "principals" AS q
		WHERE q."tenant_id" = p."tenant_id"
			AND q."handle" = regexp_replace(p."handle", '-chief$', '-twin')
	);
--> statement-breakpoint
UPDATE "principals"
SET "display_name" = regexp_replace("display_name", '的幕僚长$', '的分身')
WHERE "kind" = 'agent' AND "display_name" LIKE '%的幕僚长';
--> statement-breakpoint
UPDATE "principals"
SET "display_name" = regexp_replace("display_name", '的执行助理$', '的执行助手')
WHERE "kind" = 'agent' AND "display_name" LIKE '%的执行助理';
--> statement-breakpoint
UPDATE "agents"
SET "description" = replace(replace("description", '幕僚长', '分身'), '执行助理', '执行助手')
WHERE "description" LIKE '%幕僚长%' OR "description" LIKE '%执行助理%';
--> statement-breakpoint
-- 旁路私聊（某人 + 别人的代理，代理的本人不在或只是 observer）：本人成为成员，变成两人私聊；
-- 两人之间已有私聊时保持原样。
INSERT INTO "conversation_members" ("conversation_id", "principal_id", "tenant_id", "role")
SELECT c."id", a."owner_id", c."tenant_id", 'member'
FROM "conversations" AS c
JOIN "conversation_members" AS am ON am."conversation_id" = c."id" AND am."role" = 'member'
JOIN "principals" AS a ON a."id" = am."principal_id" AND a."kind" = 'agent'
JOIN "conversation_members" AS rm ON rm."conversation_id" = c."id" AND rm."role" = 'member'
JOIN "principals" AS r ON r."id" = rm."principal_id" AND r."kind" = 'human'
WHERE c."kind" = 'dm'
	AND a."owner_id" <> r."id"
	AND (
		SELECT count(*) FROM "conversation_members" AS m2
		WHERE m2."conversation_id" = c."id" AND m2."role" = 'member'
	) = 2
	AND NOT EXISTS (
		SELECT 1
		FROM "conversation_members" AS x
		JOIN "conversation_members" AS y
			ON y."conversation_id" = x."conversation_id"
			AND y."principal_id" = a."owner_id"
			AND y."role" = 'member'
		JOIN "conversations" AS c2 ON c2."id" = x."conversation_id" AND c2."kind" = 'dm'
		WHERE x."principal_id" = r."id"
			AND x."role" = 'member'
			AND x."conversation_id" <> c."id"
	)
ON CONFLICT ("conversation_id", "principal_id") DO UPDATE SET "role" = 'member';
--> statement-breakpoint
-- 两个真人的私聊：双方的分身都是成员。
INSERT INTO "conversation_members" ("conversation_id", "principal_id", "tenant_id", "role")
SELECT c."id", twin."id", c."tenant_id", 'member'
FROM "conversations" AS c
JOIN "conversation_members" AS m ON m."conversation_id" = c."id" AND m."role" = 'member'
JOIN "principals" AS h ON h."id" = m."principal_id" AND h."kind" = 'human'
JOIN "principals" AS twin ON twin."owner_id" = h."id" AND twin."kind" = 'agent'
JOIN "agents" AS a ON a."principal_id" = twin."id" AND a."role" = 'front'
WHERE c."kind" = 'dm'
	AND (
		SELECT count(*)
		FROM "conversation_members" AS m2
		JOIN "principals" AS h2 ON h2."id" = m2."principal_id" AND h2."kind" = 'human'
		WHERE m2."conversation_id" = c."id" AND m2."role" = 'member'
	) = 2
ON CONFLICT ("conversation_id", "principal_id") DO NOTHING;
