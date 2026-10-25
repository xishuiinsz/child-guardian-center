/**
 * 渲染进程 ↔ 主进程的 IPC 契约类型，全项目唯一一份声明。
 *
 * 为什么放在 src/preload 目录下：
 * - tsconfig.node.json 的 include 覆盖了整个 src/preload 目录（主进程 / preload 可见）
 * - tsconfig.web.json 的 include 覆盖了 src/preload 下的全部 .d.ts（渲染进程可见）
 * 两边都能自动吃到，不需要改任何 tsconfig。
 *
 * 为什么必须叫 ipc.d.ts 而不能塞进 index.d.ts：
 * TS 在同一个程序里会用同名 .ts 遮蔽 .d.ts，index.d.ts 和 index.ts 并存时
 * 前者会被踢出 tsconfig.node 的程序（--listFiles 里看不到），
 * 于是主进程引用不到里面的全局类型。ipc.ts 不存在，所以 ipc.d.ts 不会被遮蔽。
 *
 * 本文件只有类型、没有运行时代码，引用方一律写 `import type`（tsconfig 开了 isolatedModules）。
 */

/** user:list 通道传输的单条用户信息 */
export interface UserInfo {
  /** 用户 id：取本地账户 SID 的末段 RID，稳定唯一（不像数组下标会随排序 / 过滤变化） */
  id: number
  /** 用户名 */
  name: string
  isAdmin: boolean
  /**
   * 单次最少休息时长（分钟）。
   * 目前由主进程按 dailyRoutineConfig 的全局默认值兜底，接入本地存储后改为按用户读取。
   */
  allowedDuration: number
  disabledTimes: number
}

/** preload 通过 contextBridge 暴露到 window.api 的自定义渲染进程 API */
export interface Api {
  getUserList: () => Promise<UserInfo[]>
  setUerData: (p: UserInfo) => Promise<boolean>
}
