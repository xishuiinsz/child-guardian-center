import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Api, UserInfo } from './ipc'

// Custom APIs for renderer
/**
 * 渲染进程专用的自定义 API（契约类型见同目录 ipc.d.ts）。
 *
 * 为什么在 preload 包一层，而不是让渲染层直接调 window.electron.ipcRenderer.invoke：
 * 1. @electron-toolkit/preload 里 invoke 的签名是 (channel, ...args) => Promise<any>，
 *    渲染层拿到的是 any；包一层后返回值就是明确的 UserInfo[]。
 * 2. channel 字符串集中在 preload，渲染层不感知 IPC 细节。
 */
const api: Api = {
  /** 获取系统用户列表：对应主进程 ipcMain.handle('user:list') */
  getUserList: (): Promise<UserInfo[]> => ipcRenderer.invoke('user:list'),
  setUerData: (p: UserInfo): Promise<boolean> => ipcRenderer.invoke('user:data', p)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
