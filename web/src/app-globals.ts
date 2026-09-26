/// <reference lib="dom" />
/**
 * 应用级全局运行态：一次连接内基本不变的服务端「身份 / 能力」信息，放模块级单例，
 * 任何组件 `useAppGlobals()` 直接读，不用再一层层传 props。
 *
 * 为什么不用 props / Context：
 *  - `managed`（PI_WEB_MANAGED）、`tabs`（PI_WEB_TABS）、
 *    `service`（是否被平台服务托管，更新面板的「重启服务」靠它）、版本号这些是
 *    「整棵树都要知道、整个连接内只变一次」的信息，却要钻进
 *    GoalBar / SettingsModal / PiSetupModal / ChatInput…… 传参版漏一个就是一个看不见的
 *    分支走错（DSH 少一道 gating、managed 实例多出安装按钮）。
 *  - 它们也不属于快照流（只在 `ready` 消息里来一次），用 Context 还得在每个可能被
 *    单独渲染的子树里再包 Provider（插件视图、portal 弹窗最容易漏）。
 *
 * ⚠️ 纪律（改动本文件前先读）：
 *  1. 只放**极少变化**的字段。`messages` / `state` / `settings` / `streaming` 这类
 *     快照流里的东西绝不放进来 —— ChatInput 等 memo() 组件靠「窄 props + 引用稳定」
 *     躲开流式重渲染，而 store 通知会**绕过 memo()** 直接重渲染订阅者。
 *  2. `getSnapshot()` 必须返回稳定引用：只有 `setAppGlobals` 真正改了字段才替换对象
 *     并通知，否则 useSyncExternalStore 会判定「快照每次都变」而不停重渲染（甚至死循环）。
 *  3. 写入点只有一处：`use-chat.ts` 收到 `ready` 时（改前请确认没有第二个 source of truth）。
 *
 * 与 title-settings.ts / chat-width-settings.ts 同构：模块级 cached + listener 集合 + useSyncExternalStore。
 *
 * 两块内容：
 *  - **状态**（本文件上半部分）：`ready` 携带的身份/能力信息 + 连接态与当前工作目录
 *    → `useAppField(key)` / `useAppGlobals()`。
 *  - **动作**（下半部分）：全局发送器 `appSend` —— 引用稳定，任何地方 import 即用
 *    （它不触发重渲染，所以不需要 hook）。
 *
 * 边界：「整棵树都要 + 低频」才进来。`chat.*` 里的快照流数据（messages / state /
 * settings / models …）仍由 useChat 持有并逐层传（TopBar/FooterBar 这类本来就吃
 * 整个 ChatState 的组件不算传参问题）。这里只是把「几乎人人要、又懒得传」的那几个
 * 值镜像出来，方便深子树（插件视图、portal 弹窗）直接取。
 */

import { useSyncExternalStore } from "react";
import type { ClientMessage, UiServiceInfo } from "./types";
// 仅类型（编译期擦除）：ConnStatus 定义在 use-chat（快照机那里），这里只借用联合类型。
import type { ConnStatus } from "./use-chat";

export interface AppGlobals {
	/** PI_WEB_MANAGED=1：更新与插件安装由部署方负责，界面不提供入口。 */
	managed: boolean;
	/** PI_WEB_TABS：本实例提供的 tab 白名单；undefined = 全部（默认）。 */
	tabs?: string[];
	/** 托管本实例的平台服务（`pi-web-ui server start|install` 起的）——
	 *  undefined = 前台/dev/Docker，没有 supervisor。见 server/launch-origin.ts。 */
	service?: UiServiceInfo;
	/** pi-web-ui 自身版本（`ready` 携带）。 */
	appVersion?: string;
	/** pi SDK 版本（`ready` 携带）。 */
	serverVersion?: string;
	/** 连接状态（与 useChat 的 ConnStatus 同值）。 */
	status: ConnStatus;
	/** 会话已就绪（hello 处理完 + 已有快照）—— 输入框/左栏靠它决定能不能用。 */
	ready: boolean;
	/** 当前工作目录（当前对话的 cwd；空串 = 尚未知）。 */
	cwd: string;
}

export const DEFAULT_APP_GLOBALS: AppGlobals = {
	managed: false,
	status: "connecting",
	ready: false,
	cwd: "",
};

let cached: AppGlobals = DEFAULT_APP_GLOBALS;
const listeners = new Set<() => void>();

/** 数组按元素比（同一个 ready 重放时是新数组，引用比会假变更）。 */
function sameArray(a?: string[], b?: string[]): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function same(a: AppGlobals, b: AppGlobals): boolean {
	return (
		a.managed === b.managed &&
		a.appVersion === b.appVersion &&
		a.serverVersion === b.serverVersion &&
		a.status === b.status &&
		a.ready === b.ready &&
		a.cwd === b.cwd &&
		sameArray(a.tabs, b.tabs) &&
		// ready 每次重连都会带一份新的 service 对象——比字段，避免白重渲染。
		a.service?.name === b.service?.name &&
		a.service?.supervisor === b.service?.supervisor
	);
}

/** 合并写入（只传变化字段）。字段值没变时**不通知**，避免重连时白重渲染一遍。 */
export function setAppGlobals(patch: Partial<AppGlobals>): void {
	const next: AppGlobals = { ...cached, ...patch };
	if (same(cached, next)) return;
	cached = next;
	for (const l of listeners) l();
}

/** 非 React 代码（WS handler / 工具函数 / 扩展桥）读当前值。 */
export function getAppGlobals(): AppGlobals {
	return cached;
}

/** 仅测试用：回到默认值（不通知订阅者）。 */
export function resetAppGlobals(): void {
	cached = DEFAULT_APP_GLOBALS;
}

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

/** 非 React 代码订阅变更（React 组件请用 useAppGlobals）。返回退订函数。 */
export function subscribeAppGlobals(cb: () => void): () => void {
	return subscribe(cb);
}

function getSnapshot(): AppGlobals {
	return cached;
}

/** 整个全局对象（引用稳定：只在真正变更时替换）。
 *  ⚠️ 只用得上一个字段时请用 `useAppField(key)` —— 本 hook 在**任何**字段变化时
 *  都会重渲染订阅者。 */
export function useAppGlobals(): AppGlobals {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 单字段订阅：只有这个字段真的变了才重渲染（值比较走 Object.is）。
 *  字段是数组/对象时依赖 `setAppGlobals` 保持的引用稳定（只在本模块替换）。 */
export function useAppField<K extends keyof AppGlobals>(key: K): AppGlobals[K] {
	return useSyncExternalStore(
		subscribe,
		() => cached[key],
		() => cached[key],
	);
}

/** 实例是否受管（PI_WEB_MANAGED=1）。 */
export function useIsManaged(): boolean {
	return useAppField("managed");
}

/** 托管本实例的平台服务（有值 = 由 `pi-web-ui server start|install` 启动，
 *  退出后会被 supervisor 拉起）；前台/dev 实例返回 undefined。 */
export function useServiceInfo(): UiServiceInfo | undefined {
	return useAppField("service");
}

/* ------------------------------------------------------------------ */
/* 全局动作：WebSocket 发送器                                            */
/* ------------------------------------------------------------------ */

/** 发送一条客户端消息，返回是否真的送出去了（连接未开 = false）。 */
export type AppSend = (msg: ClientMessage) => boolean;

let sendImpl: AppSend | null = null;

/** 由 use-chat 装配（send 本身是 useCallback([])，连接开/关由它内部判定）。 */
export function setAppSend(fn: AppSend | null): void {
	sendImpl = fn;
}

/** 全局发送器：引用稳定，可直接 import 后调用，不用 hook、不参与重渲染。
 *  未装配（还没 useChat）/ 连接未开 → 返回 false，与 send 的既有语义一致。 */
export const appSend: AppSend = (msg) => (sendImpl ? sendImpl(msg) : false);
