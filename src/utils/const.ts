/**
 * 日常作息配置：数值单位统一是分钟（unit 只是给 UI / 日志看的说明，不参与计算）。
 *
 * 这里是**全局默认值**，两处消费：
 * - 渲染进程：输入框初值（`@utils/const`，见 App.tsx）
 * - 主进程：给用户列表兜底 minRestDuration（见 main/index.ts 的 toUserInfo）
 *
 * 接了本地存储 / 后端之后，应改成按用户维度读取，本文件只保留出厂默认值。
 */
export const durationConfigInit = {
  allowedDuration: 60 * 60, // 1 hour in milliseconds
  disabledTimes: 2 // 2 hours in milliseconds
}

export const delay = 1 * 1000
