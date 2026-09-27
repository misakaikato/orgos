import { z } from "zod";

const UuidSchema = z.uuid();

/** 路径参数里的 id 先过这一关：不是 uuid 的一律按"不存在"处理，不让数据库报类型错误。 */
export function isUuid(value: string): boolean {
	return UuidSchema.safeParse(value).success;
}
