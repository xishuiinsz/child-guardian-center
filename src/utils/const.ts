import Store from 'electron-store'

const store = new Store({
  // 指定子目录，避免与 Chromium 目录冲突
  cwd: 'app-config',
  name: 'userConfig' // 最终文件为 userConfig.json
})

export const timeRate = 60 * 1000 // 1分钟的毫秒数;

export const durationConfigInit = {
  allowedDuration: 2 * timeRate,
  disabledTimes: 2
}

export const storeSet = (countdown: string, status: string): void => {
  try {
    store.set(countdown, status)
  } catch (error) {
    console.error('Error writing to userConfig.json:', error)
  }
}

try {
  const data = store.store
  if (data) {
    if (typeof data.allowedDuration === 'number') {
      Object.assign(durationConfigInit, {
        allowedDuration: Math.abs(parseInt(String(data.allowedDuration))) * timeRate
      })
    }
    if (typeof data.disabledTimes === 'number' && Number.isInteger(data.disabledTimes)) {
      Object.assign(durationConfigInit, {
        disabledTimes: Math.abs(parseInt(String(data.disabledTimes)))
      })
    }
  }
} catch (error) {
  console.error('Error reading userConfig.json:', error)
}

console.log('durationConfigInit', durationConfigInit)

export const delay = 1 * 1000
