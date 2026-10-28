import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { UserInfo } from '@preload/ipc'
import { delay, durationConfigInit } from '@utils/const'
import type { LocalUser, UserTiming } from '@utils/index'
import { getLocalUsers, lockScreen, parseSidRid, StatusEnum, toErrorMessage } from '@utils/index'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import Store from 'electron-store'
import os from 'node:os'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'

const { username } = os.userInfo()
console.log(username) // Kai Zhang（Windows 登录账户名）

const cachedData: {
  timer: null | NodeJS.Timeout
  polling: boolean
  mainWindow: BrowserWindow | null
} = {
  timer: null,
  polling: true,
  mainWindow: null
}

interface StoredDurationConfig {
  allowedDuration?: number
  disabledTimes?: number
}

const toUserInfo = (user: LocalUser, stored: StoredDurationConfig): UserInfo => ({
  id: parseSidRid(user.sid),
  name: user.name,
  isAdmin: user.isAdmin,
  allowedDuration: stored.allowedDuration ?? durationConfigInit.allowedDuration,
  disabledTimes: stored.disabledTimes ?? durationConfigInit.disabledTimes
})

function createWindow(): void {
  // Create the browser window.
  cachedData.mainWindow = new BrowserWindow({
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

  cachedData.mainWindow.on('ready-to-show', () => {
    cachedData.mainWindow?.show()
  })

  cachedData.mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged) {
    cachedData.mainWindow.webContents.openDevTools({ mode: 'right' })
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    cachedData.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    cachedData.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const store = new Store({
  // 指定子目录，避免与 Chromium 目录冲突
  cwd: 'app-config',
  name: 'userConfig' // 最终文件为 userConfig.json
})

const getInitUserTiming = (): UserTiming => {
  const nowTime = Date.now()
  const data: UserTiming = {
    lastTime: nowTime,
    status: StatusEnum.available,
    countdown: durationConfigInit.allowedDuration
  }
  return data
}

const userTiming: UserTiming = getInitUserTiming()

const overTimeCheck = () => {
  userTiming.countdown -= delay
  if (userTiming.status === StatusEnum.available) {
    if (userTiming.countdown < 0) {
      Object.assign(userTiming, {
        status: StatusEnum.disabled,
        countdown: durationConfigInit.allowedDuration * durationConfigInit.disabledTimes
      })
      lockScreen()
    }
  } else if (userTiming.status === StatusEnum.disabled) {
    if (userTiming.countdown < 0) {
      Object.assign(userTiming, {
        status: StatusEnum.available,
        countdown: durationConfigInit.allowedDuration
      })
    }
  }
  if (cachedData.polling) {
    cachedData.timer = setTimeout(overTimeCheck, delay)
  } else {
    cachedData.timer && clearTimeout(cachedData.timer)
  }
}

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

  overTimeCheck()

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
  ipcMain.handle('user:data', async (_event, payload) => {})

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 锁屏/解锁监听器只在 app ready 时注册一次，绝不要把 powerMonitor.on(...) 写进
  // 会被反复调用的函数里（或在事件回调里再 on()），否则监听器会累积：
  // 一次锁屏/解锁会触发 N 个回调（打印 N 次、overTimeCheck 被启动 N 次）。
  // 注意 Node 的 EventEmitter 在 emit 时会先复制监听器数组，回调里再 removeAllListeners
  // 也拦不住本次 emit 的其余回调，所以「先摘后挂」的写法在这里同样不可靠。
  powerMonitor.on('lock-screen', () => {
    console.log('lock-screen')
    cachedData.polling = false // 锁屏期间暂停计时
    if (cachedData.timer) clearTimeout(cachedData.timer)
    cachedData.timer = null
  })

  powerMonitor.on('unlock-screen', () => {
    console.log('unlock-screen')
    // 幂等：即使解锁事件重复到达，也只会恢复一条计时链
    if (!cachedData.polling) {
      cachedData.polling = true
      overTimeCheck()
    }
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
