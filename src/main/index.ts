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
console.log(username) // Kai Zhang（Windows 登录账户名）

const cachedData: {
  isLocked: boolean
  timer: null | NodeJS.Timeout
  mainWindow: BrowserWindow | null
} = {
  isLocked: false,
  timer: null,
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

const clearTimer = (): void => {
  if (cachedData.timer) {
    clearTimeout(cachedData.timer)
    cachedData.timer = null
  }
}

/**
 * 计时主循环：按真实流逝时间扣减 -> 到点切状态 / 锁屏 -> 无条件续期。
 *
 * 三个不能改的点：
 * 1. 扣减用 `now - lastTime` 而不是固定的 `delay`。setTimeout 本身不保证精度，
 *    而且定时器在系统睡眠期间不触发，固定扣减会让孩子靠「让机器睡一会儿」把可用时长拖长。
 * 2. 休息结束切回 available 之后必须继续排下一次定时器。历史版本在这里把 `polling`
 *    置成 false，而全文件再没有一处把它改回 true，结果第一轮「可用 + 强制休息」跑完后
 *    计时永久停摆，孩子此后可以无限期使用电脑。
 * 3. 排定时器前先 clearTimer：这样任何路径重复调用本函数都不会叠出两个定时器。
 */
const overTimeCheck = (): void => {
  const now = Date.now()
  // Math.max 兜住系统时钟回拨（NTP 校时 / 夏令时），回拨时这一拍不扣而不是倒加时长
  userTiming.countdown -= Math.max(0, now - userTiming.lastTime)
  userTiming.lastTime = now

  console.log('userTiming: ', userTiming.status, userTiming.countdown / 1000)

  if (userTiming.countdown <= 0) {
    if (userTiming.status === StatusEnum.available) {
      // 可用时长耗尽 -> 进入强制休息，休息时长 = 可用时长 * 禁用倍数
      Object.assign(userTiming, {
        status: StatusEnum.disabled,
        countdown: durationConfigInit.allowedDuration * durationConfigInit.disabledTimes
      })
      lockScreen()
    } else {
      // 强制休息结束 -> 回到可用状态，开启下一轮循环（这里绝不能停表）
      Object.assign(userTiming, {
        status: StatusEnum.available,
        countdown: durationConfigInit.allowedDuration
      })

      // 唯一的例外：孩子休息期间就走开了，屏幕还锁着。
      // 休息是在 disabled 状态下锁的屏，lock-screen 回调当时不会停表（停了休息就永远结束不了），
      // 所以切回 available 这一刻必须补一次判断，否则「可用 + 锁屏 = 停止计时」的不变式被打破：
      // 刚拿回来的额度会在没人用电脑的时候白白烧掉，甚至烧到又触发下一轮强制休息。
      // 这里停表，等 unlock-screen 回调里的 resumeTiming() 再起。
      if (cachedData.isLocked) {
        pauseTimer()
        return
      }
    }
  } else {
    if (userTiming.status === StatusEnum.disabled) {
      lockScreen()
    }
  }
  storeSet(String(userTiming.countdown), userTiming.status)
  clearTimer()
  cachedData.timer = setTimeout(overTimeCheck, delay)
}

/**
 * 停表，并把计时锚点推到当前时刻。
 *
 * 锚点必须跟着停表一起推进：overTimeCheck 是按 `now - lastTime` 扣真实时间的，
 * 只清定时器不改 lastTime 的话，停表期间那段间隔会在下次起表时被一次性扣掉
 * （锁屏 10 分钟 = 白扣 10 分钟可用时长），与「可用状态下锁屏则停止计时」相悖。
 */
const pauseTimer = (): void => {
  clearTimer()
  userTiming.lastTime = Date.now()
}

/** 重新起表：先丢弃停表期间的间隔，再立刻走一次检查并续期 */
const resumeTiming = (): void => {
  userTiming.lastTime = Date.now()
  clearTimer()
  overTimeCheck()
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

  // 首轮起表前把锚点推到当前：从模块加载到 app ready 之间的耗时
  // （portable 版解压可达约 9 秒）不该算进孩子的可用时长
  userTiming.lastTime = Date.now()
  overTimeCheck()

  ipcMain.handle('user:list', async (): Promise<UserInfo[]> => {
    // 迭代一暂不实现 store.get()，直接返回默认值。
    return []
  })

  ipcMain.handle('user:data', async (_event, _payload) => {})

  // 迭代一暂不实现客户端窗口
  // createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  powerMonitor.on('lock-screen', () => {
    if (cachedData.isLocked) {
      return
    }
    cachedData.isLocked = true
    // 只有可用状态才停表：强制休息期间屏幕本来就是锁着的，休息倒计时必须继续走，
    // 否则孩子一锁屏就能把休息时间「冻住」
    if (userTiming.status === StatusEnum.available) {
      pauseTimer()
    }
  })

  // unlock-screen 必须在顶层注册、且只注册一次。历史版本把它写在 lock-screen 回调内部，
  // 每锁一次屏就多挂一个监听器，十几轮锁/解锁后就超过 EventEmitter 默认上限 10 个，
  // 报 MaxListenersExceededWarning 并持续泄漏。
  powerMonitor.on('unlock-screen', () => {
    if (!cachedData.isLocked) {
      return
    }
    // 顺序不能反：先把锁屏标记清掉，再走检查。
    // 否则 overTimeCheck 里「休息结束但屏幕还锁着就停表」那条分支会误判成仍在锁屏，白白停一次表。
    cachedData.isLocked = false
    // 解锁一律重新调用 overTimeCheck 结算（resumeTiming 内部就是「丢弃锁屏间隔 + overTimeCheck」），
    // 由它决定接下来干什么，回调里不再自己判状态：
    // - 休息已结束 -> 切回 available，正常起表，孩子接着用；
    // - 休息没结束 -> overTimeCheck 的 disabled 分支会立刻 lockScreen() 锁回去。
    // 旧写法在这里直接按「解锁那一刻的 status」决定要不要锁回去，休息刚好在这一拍结束时会多锁一次，
    // 孩子得再解一遍锁才能用上电脑。
    resumeTiming()
  })

  powerMonitor.on('suspend', () => {
    console.log('开始休眠')
    // 睡眠期间定时器不触发，改成按真实时间扣减后，不显式停表就会把整段睡眠算成已用时长
    pauseTimer()
  })

  powerMonitor.on('resume', () => {
    console.log('休眠结束')
    // 醒来先丢弃睡眠这段时间，再决定要不要起表
    userTiming.lastTime = Date.now()
    // 可用状态下锁屏期间本该停表，醒来也要保持停表，等解锁再起
    if (cachedData.isLocked && userTiming.status === StatusEnum.available) {
      clearTimer()
      return
    }
    resumeTiming()
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
