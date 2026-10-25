import { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from './ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
