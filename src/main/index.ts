import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { UserInfo } from '@preload/ipc'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import Store from 'electron-store'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { durationConfigInit } from '../utils/const'
import type { LocalUser } from '../utils/index'
import {  getLocalUsers, parseSidRid, toErrorMessage } from '@utils/index'
import os from 'node:os'

const { username } = os.userInfo()
console.log(username) // Kai Zhang（Windows 登录账户名）

/**
 * electron-store 里按用户名存的那份时长配置。
 *
 * 只存这两项：name / sid / lastLogon 这些每次采集都是最新的，没必要也不该落库。
 * 字段声明成可选是因为旧数据可能缺项，读出来一律由 toUserInfo 用出厂默认值兜底。
 */
interface StoredDurationConfig {
  allowedDuration?: number
  disabledTimes?: number
}

/**
 * LocalUser（采集层结构）→ UserInfo（IPC 契约，见 src/preload/ipc.d.ts）。
 *
 * 必须显式构造，不能用原来的 `Object.assign(user, userSettings)`：
 * 1. LocalUser 里根本没有 id 字段，assign 之后 UserInfo.id 依然是 undefined。
 *    而渲染层 App.tsx 的 change() 靠 `prevUser.id === data.id` 定位要改哪一行 ——
 *    id 全是 undefined 时这个判断恒为 true，改任意一个输入框会把所有用户一起改掉；
 *    `key={user.id || user.name}` 也会退化成用 name 当 key（同名账户 / 排序变化时不可靠）。
 *    这里用 parseSidRid(user.sid) 取 SID 末段 RID，稳定且唯一。
 * 2. assign 是原地改采集层对象，TS 推不出结果类型，返回 LocalUser[] 会报 TS2322
 *    （LocalUser 缺 id / allowedDuration / disabledTimes）。
 */
const toUserInfo = (user: LocalUser, stored: StoredDurationConfig): UserInfo => ({
  id: parseSidRid(user.sid),
  name: user.name,
  isAdmin: user.isAdmin,
  allowedDuration: stored.allowedDuration ?? durationConfigInit.allowedDuration,
  disabledTimes: stored.disabledTimes ?? durationConfigInit.disabledTimes
})

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'right' })
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const store = new Store({
  // 指定子目录，避免与 Chromium 目录冲突
  cwd: 'app-config',
  name: 'userConfig' // 最终文件为 userConfig.json
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC：user:list 必须用 handle/invoke 这一对。
  // ipcMain.on + event.reply 只能「再发一条消息」，on 回调里的 return 会被 Electron 丢弃；
  // 渲染进程 await ipcRenderer.invoke('user:list') 才能拿到这里的返回值（Promise）。
  // 若这里 throw，渲染进程的 invoke 会以 rejection 形式抛出，可直接 try/catch。
  ipcMain.handle('user:list', async (): Promise<UserInfo[]> => {
    try {
      const users = await getLocalUsers()
      const userConfig = store.store as Record<string, StoredDurationConfig | undefined>
      return users.map((user) => toUserInfo(user, userConfig[user.name.replace(' ', '')] ?? {}))
    } catch (error) {
      const message = toErrorMessage(error)
      console.error('[user:get-list] 采集失败:', message)
      // 挂上 cause：渲染进程只拿到 message，主进程日志里还能顺着 cause 看到原始堆栈
      throw new Error(message, { cause: error })
    }
  })

  // 第一个参数是 IpcMainInvokeEvent，这里用不到；必须写出来占位才能拿到第二个参数 payload。
  // 加下划线前缀是 TS 的约定：noUnusedParameters 会跳过以 `_` 开头的形参，否则报 TS6133。
  ipcMain.handle('user:data', async (_event, payload) => {
    const user = payload.name.replace(' ', '')
    const allowedDuration = payload.allowedDuration ?? durationConfigInit.allowedDuration
    const disabledTimes = payload.disabledTimes ?? durationConfigInit.disabledTimes
    store.set(`${user}.allowedDuration`, parseInt(allowedDuration))
    store.set(`${user}.disabledTimes`, parseInt(disabledTimes))
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
