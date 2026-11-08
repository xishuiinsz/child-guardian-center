import { dialog } from 'electron'
import { tipTime } from './const'

export const showMessageBox = async () => {
  const { response } = await dialog.showMessageBox({
    type: 'warning', // none | info | error | question | warning
    title: '请合理使用电脑', // 部分平台不显示，主要内容看 message
    message: `仅剩下${tipTime / 60}分钟使用时间，请尽快保存相关文件`, // 主要内容
    detail: '请合理安排使用电脑的时间，避免长时间沉迷于电脑，影响身心健康。', // 仅在 macOS 上显示
    buttons: [], // 返回被点击按钮的下标
    defaultId: 1, // 回车选中项
    cancelId: 0, // Esc 对应项
    noLink: true // Windows 特有：见下方平台差异
  })
  return response
}
