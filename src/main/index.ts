import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { UserInfo } from '@preload/ipc'
import { delay, durationConfigInit, storeSet } from '@utils/const'
import type { UserTiming } from '@utils/index'
import { lockScreen, StatusEnum } from '@utils/index'
import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron'
import os from 'node:os'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'

const { username } = os.userInfo()
console.log(`当前登录用户：${username}`)

const cachedData: {
  isLockScreen: boolean
  polling: boolean
  mainWindow: BrowserWindow | null
} = {
  isLockScreen: false,
  polling: true,
  mainWindow: null
}

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

const overTimeCheck = (): void => {
  const now = Date.now()
  const diffTime = now - userTiming.lastTime
  userTiming.countdown -= Math.abs(diffTime)
  userTiming.lastTime = now

  console.log(`${userTiming.status}: ${userTiming.countdown / 1000} 秒 `)

  if (userTiming.countdown > 0) {
    if (userTiming.status === StatusEnum.disabled) {
      if (!cachedData.isLockScreen) {
        return
      }
      lockScreen()
      return
    }
  } else {
    if (userTiming.status === StatusEnum.available) {
      // 可用时长耗尽 -> 进入强制休息，休息时长 = 可用时长 * 禁用倍数
      Object.assign(userTiming, {
        status: StatusEnum.disabled,
        countdown: durationConfigInit.allowedDuration * durationConfigInit.disabledTimes
      })
    } else {
      // 强制休息结束 -> 回到可用状态，开启下一轮循环（这里绝不能停表）
      Object.assign(userTiming, {
        status: StatusEnum.available,
        countdown: durationConfigInit.allowedDuration
      })
    }
  }
  storeSet(String(userTiming.countdown), userTiming.status)
  // 定时器 tick 一律按「孩子不在场」传参，理由见 overTimeCheck 的 @param present 说明
  if (cachedData.polling) {
    setTimeout(overTimeCheck, delay)
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

  ipcMain.handle('user:list', async (): Promise<UserInfo[]> => {
    // 迭代一暂不实现 store.get()，直接返回默认值。
    return []
  })

  ipcMain.handle('user:data', async (_event, _payload) => {})

  // 迭代一暂不实现客户端窗口
  // createWindow()

  overTimeCheck()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  powerMonitor.on('lock-screen', () => {
    if (cachedData.isLockScreen) {
      return
    }
    console.log('锁屏')
    cachedData.polling = false
    cachedData.isLockScreen = true
    let unLockEventFlag = false
    powerMonitor.removeAllListeners('unlock-screen')
    powerMonitor.on('unlock-screen', () => {
      if (unLockEventFlag) {
        return
      }
      console.log('解锁')
      unLockEventFlag = true
      cachedData.isLockScreen = false
      cachedData.polling = true
      overTimeCheck()
    })
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
