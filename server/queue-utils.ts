/**
 * 排队消息（插队 steer / 排队 followUp）纯函数 —— 独立成模块是为了可单测
 * （`AgentService` 依赖 SDK 与运行时，不适合在单测里 import）。
 *
 * 背景：pi SDK 没有「按条操作队列」的 API，服务端移除一条排队消息的做法是
 * `clearQueue()` 之后把幸存者按原顺序重新入队（见 `AgentService.removeQueued`）。
 * 重建时若用值过滤（`list.filter((t) => t !== text)`），会把**所有**同文本项一起删掉；
 * 而气泡上的 ✕ 只对应一条消息、本地显示镜像也只移除一条 → 同一条文本被排队两次时
 * 「点一次 ✕ 删两条」，且显示与真实队列在下次 `queue_update` 之前不一致。
 * 因此统一按「只移除第一处匹配」处理。
 */

/** 移除列表中第一处等于 `text` 的项；找不到时返回入参的拷贝（不修改入参）。 */
export function removeFirstOccurrence(list: readonly string[], text: string): string[] {
	const index = list.indexOf(text);
	if (index < 0) return [...list];
	return [...list.slice(0, index), ...list.slice(index + 1)];
}
