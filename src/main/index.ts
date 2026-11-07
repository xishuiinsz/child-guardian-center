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

type SessionEventType = 'lock' | 'unlock'

/**
 * 同一类会话事件在这个时间窗内重复到达就丢弃。
 * Windows 上锁屏 / 解锁事件可能瞬时连发两次，不去重会让同一次锁屏被结算两遍。
 */
const SESSION_EVENT_DEDUP_MS = 500

/**
 * 注意：这里刻意**不保存**「屏幕是否锁着」。
 * 锁屏状态只在事件到达的那一刻有用，用完即弃 —— lock-screen 当场决定要不要停表，
 * unlock-screen 当场调 resumeTiming(true)。一旦存成字段，它就变成一份可能过期、
 * 又被多处读取的隐式全局状态（旧版本的 isLocked 就是这样兼了去重和锁屏状态两职）。
 * 唯一无法回避「事后还要知道锁没锁」的场景是 resume（唤醒），取舍见该回调注释。
 */
const cachedData: {
  /** 上一次已处理的会话事件，只服务于去重，不参与任何计时判断 */
  lastSessionEvent: { type: SessionEventType; at: number } | null
  lockEventFlag: boolean
  timer: null | NodeJS.Timeout
  mainWindow: BrowserWindow | null
} = {
  lastSessionEvent: null,
  lockEventFlag: false,
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
 * @param present 孩子此刻是否在电脑前（屏幕未锁）。**只在「强制休息结束 -> 切回 available」
 *   这一个分支被读**：不在场就必须停表，否则刚发下来的额度会在没人用的时候白白烧掉，
 *   甚至烧到又触发下一轮强制休息。各调用点的取值依据：
 *   - 定时器 tick -> `false`。tick 能走进那个分支说明当时是 disabled，
 *     而休息期间的屏幕是本项目自己锁的（且每拍重锁一次），孩子必然不在场。
 *     注意 tick 传 false 不影响正常计时：available 状态下走不到读 present 的那个分支。
 *   - unlock-screen -> `true`，解锁事件就是「孩子在电脑前」的唯一可靠证据。
 *   - app ready / resume -> `true`，理由见各自调用点注释。
 *
 * 三个不能改的点：
 * 1. 扣减用 `now - lastTime` 而不是固定的 `delay`。setTimeout 本身不保证精度，
 *    而且定时器在系统睡眠期间不触发，固定扣减会让孩子靠「让机器睡一会儿」把可用时长拖长。
 * 2. 休息结束切回 available 之后必须继续排下一次定时器。历史版本在这里把 `polling`
 *    置成 false，而全文件再没有一处把它改回 true，结果第一轮「可用 + 强制休息」跑完后
 *    计时永久停摆，孩子此后可以无限期使用电脑。
 * 3. 排定时器前先 clearTimer：这样任何路径重复调用本函数都不会叠出两个定时器。
 */
const overTimeCheck = (present: boolean): void => {
  const now = Date.now()
  // Math.max 兜住系统时钟回拨（NTP 校时 / 夏令时），回拨时这一拍不扣而不是倒加时长
  userTiming.countdown -= Math.max(0, now - userTiming.lastTime)
  userTiming.lastTime = now

  console.log(`${userTiming.status}：${userTiming.countdown / 1000} 秒 `)

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
      // 这里停表，等 unlock-screen 回调里的 resumeTiming(true) 再起。
      if (!present) {
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
  // 定时器 tick 一律按「孩子不在场」传参，理由见 overTimeCheck 的 @param present 说明
  cachedData.timer = setTimeout(() => overTimeCheck(false), delay)
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

/** 重新起表：先丢弃停表期间的间隔，再立刻走一次检查并续期。present 原样透传给 overTimeCheck */
const resumeTiming = (present: boolean): void => {
  userTiming.lastTime = Date.now()
  clearTimer()
  overTimeCheck(present)
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
  // present = true：计划任务在用户登录时启动，此刻屏幕必然是解锁的
  overTimeCheck(true)

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
    if (cachedData.lockEventFlag) {
      return
    }
    console.log('锁屏')
    cachedData.lockEventFlag = true
    let unLockEventFlag = false
    // 只有可用状态才停表：强制休息期间屏幕本来就是锁着的，休息倒计时必须继续走，
    // 否则孩子一锁屏就能把休息时间「冻住」。
    // 锁屏这件事本身不需要记下来 —— 停表就是它对计时系统的全部影响，当场做完即可。
    if (userTiming.status === StatusEnum.available) {
      pauseTimer()
    }
    powerMonitor.on('unlock-screen', () => {
      if (unLockEventFlag) {
        return
      }
      console.log('解锁')
      unLockEventFlag = true
      resumeTiming(true)
    })
  })

  powerMonitor.on('suspend', () => {
    console.log('开始休眠')
    // 睡眠期间定时器不触发，改成按真实时间扣减后，不显式停表就会把整段睡眠算成已用时长
    pauseTimer()
  })

  powerMonitor.on('resume', () => {
    console.log('休眠结束')
    // 醒来先丢弃睡眠这段时间，再起表
    userTiming.lastTime = Date.now()
    // 本项目不保存锁屏状态字段，唤醒时无从得知屏幕是锁着还是开着，一律按「孩子在电脑前」处理。
    //
    // 已知代价（评估后接受）：若睡眠前屏幕是锁着的、且系统未配置「唤醒时需要登录」，
    // 唤醒后计时会在没人用的情况下继续走 —— 孩子回来时可能发现额度已被烧掉，
    // 甚至正好落在强制休息里被再锁一次。Modern Standby 机器会周期性自动唤醒，会放大这个窗口。
    //
    // 为什么不选「唤醒后保持停表、等解锁再起」：那种做法在「睡眠前屏幕是开着的」场景下
    // 永远等不到 unlock-screen 事件，计时会永久停摆 —— 对孩子等于无限时长，属于管控彻底失效，
    // 比多烧一点额度严重得多。两边都 fail-open 时，选失控窗口小的那个。
    resumeTiming(true)
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
