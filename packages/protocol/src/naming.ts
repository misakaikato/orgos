/**
 * 代理的称呼与 handle 规则：服务端建代理、前端显示身份与提示文案共用这一处。
 *
 * 分身（role=front）代表本人与别人沟通；助手（role=specialist）替本人干具体活，
 * 每人默认一个"执行助手"。
 */
import type { AGENT_ROLES } from "./entities";

type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABEL: Record<AgentRole, string> = {
	front: "分身",
	specialist: "助手",
};

/** 各类代理的一句定位（通讯录、代理组页的副标题）。 */
export const AGENT_ROLE_DUTY: Record<AgentRole, string> = {
	front: "对外代表你",
	specialist: "只替你办事",
};

export const DEFAULT_ASSISTANT_NAME = "执行助手";

export const TWIN_HANDLE_SUFFIX = "-twin";
export const DEFAULT_ASSISTANT_HANDLE_SUFFIX = "-ops";

export function twinHandle(ownerHandle: string): string {
	return `${ownerHandle}${TWIN_HANDLE_SUFFIX}`;
}

export function defaultAssistantHandle(ownerHandle: string): string {
	return `${ownerHandle}${DEFAULT_ASSISTANT_HANDLE_SUFFIX}`;
}

/** "林晓的分身"。 */
export function twinName(ownerName: string): string {
	return `${ownerName}的${AGENT_ROLE_LABEL.front}`;
}

/** "林晓的执行助手"。 */
export function defaultAssistantName(ownerName: string): string {
	return `${ownerName}的${DEFAULT_ASSISTANT_NAME}`;
}
