import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import PowerShell from 'powershell'
import { spawn } from 'node:child_process'

export type UserTimingStatus = 'available' | 'disabled'

export enum StatusEnum {
  available = 'available',
  disabled = 'disabled'
}

export interface UserTiming {
  status: StatusEnum
  allowedDuration: number
  disabledTimes: number
  startTime: number
  endTime: number
}

const PS_DIR_RESOURCES = join(__dirname, '..', '..', 'resources', 'ps')
/** 安装态：把 asar 内路径换成 electron-builder 解包后的真实磁盘路径（路径里没有 app.asar 时原样返回） */
const PS_DIR_UNPACKED = PS_DIR_RESOURCES.replace(
  `${sep}app.asar${sep}`,
  `${sep}app.asar.unpacked${sep}`
)
/** 兜底：脚本还留在源码目录 src/ps（历史位置）时也能跑 */
const PS_DIR_LEGACY = join(__dirname, '..', '..', 'src', 'ps')

/** 候选目录，顺序即优先级；一个都不存在时 getPsDir 返回首项，由 runPsScript 报错并列出全部候选 */
const PS_DIR_CANDIDATES = [PS_DIR_UNPACKED, PS_DIR_RESOURCES, PS_DIR_LEGACY]

/** getPsDir 的缓存：脚本目录不会在进程运行中途出现或消失，没必要每次调用都 stat */
let psDirCache: string | undefined

/**
 * 定位 ps 脚本目录：取 {@link PS_DIR_CANDIDATES} 里第一个真实存在的，兼容三种形态
 *
 * | 形态        | 命中目录                                            |
 * | ----------- | --------------------------------------------------- |
 * | 安装包      | `<安装目录>/resources/app.asar.unpacked/resources/ps` |
 * | 开发态      | `<项目根>/resources/ps`                              |
 * | 历史位置    | `<项目根>/src/ps`                                    |
 *
 * 注意候选顺序不能调换：安装态下 asar 内的 `app.asar/resources/ps` 经 Electron 的 fs 补丁
 * existsSync 也返回 true，但它不是真实磁盘路径，必须让 unpacked 那条先命中。
 */
export function getPsDir(): string {
  if (psDirCache !== undefined) {
    return psDirCache
  }

  psDirCache = PS_DIR_CANDIDATES.find((dir) => existsSync(dir)) ?? PS_DIR_UNPACKED
  return psDirCache
}

/** Win11 自带的 Windows PowerShell 5.1，路径固定，不需要额外依赖 */
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** 强制 UTF-8 输出，否则中文系统取到的是 GBK，会变成乱码 */
const UTF8_PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
/** ps 脚本扩展名：调用方省略时由 resolvePsScriptPath 自动补上 */
const PS_SCRIPT_EXT = '.ps1'

/**
 * 采集系统信息的 PowerShell 片段：一次调用拿全，避免反复拉起 powershell 进程。
 * 输出是用 `|` 连接的单行字符串，由 parseSystemInfoFromOs 解析。
 */
const SYSTEM_INFO_SCRIPT = [
  '$os = Get-CimInstance Win32_OperatingSystem;',
  '$cs = Get-CimInstance Win32_ComputerSystem;',
  '"$($os.Caption)|$($os.Version)|$($os.BuildNumber)|' +
    "$($os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss'))|$env:USERNAME|$($cs.Name)\""
].join(' ')

/** runPsScript 的返回值：聚合后的 stdout / stderr 与进程退出码 */
export interface PsScriptResult {
  stdout: string
  stderr: string
  code: number | null
}

/** 渲染进程通过 childGuardian.getSystemInfo() 最终拿到的结构 */
export interface SystemInfo {
  osCaption: string
  osVersion: string
  osBuild: string
  lastBootUpTime: string
  user: string
  hostname: string
  electron: string
  node: string
  chrome: string
}

/** SystemInfo 中来自操作系统的部分，运行时版本号由 Node 侧补齐 */
export type SystemInfoFromOs = Omit<SystemInfo, 'electron' | 'node' | 'chrome'>

/** get-local-users.ps1 采集到的本地用户，字段与脚本里 Select-Object 的输出对应 */
export interface LocalUser {
  /** 用户名 */
  name: string
  /** 登录/锁屏界面显示的名字：账户设置了全名（FullName）时为全名，否则回退为用户名 */
  displayName: string
  /** 是否启用 */
  enabled: boolean
  /** 账户来源。PowerShell 侧是枚举，ConvertTo-Json 序列化成数字（1 = Local） */
  principalSource: string
  /** 用户 SID */
  sid: string
  /** 是否为 Administrators 组成员（按知名 SID S-1-5-32-544 判定） */
  isAdmin: boolean
  /** 上次登录时间（ISO 8601），从未登录过则为空串 */
  lastLogon: string
  /** 账户描述，无则为空串 */
  description: string
}

/** 纯函数：把 unknown 异常统一转成可打印的字符串 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** JSON 里的值可能是 string / number / null，统一转成字符串（null / undefined 落成空串） */
function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** 纯函数：把 WMI 拼出来的 `Caption|Version|Build|BootTime|User|Host` 拆成字段 */
export function parseSystemInfoFromOs(raw: string): SystemInfoFromOs {
  const parts = raw.split('|')
  // tsconfig 开了 noUncheckedIndexedAccess，用默认值兜住 undefined
  const [
    osCaption = '',
    osVersion = '',
    osBuild = '',
    lastBootUpTime = '',
    user = '',
    hostname = ''
  ] = parts

  return { osCaption, osVersion, osBuild, lastBootUpTime, user, hostname }
}

/** get-local-users.ps1 输出 JSON 的单条记录：PowerShell 侧是 PascalCase，字段可能缺失或为 null */
interface RawLocalUser {
  Name?: unknown
  DisplayName?: unknown
  Enabled?: unknown
  PrincipalSource?: unknown
  SID?: unknown
  IsAdmin?: unknown
  LastLogon?: unknown
  Description?: unknown
}

/**
 * 纯函数：把 get-local-users.ps1 的 JSON 输出解析成 LocalUser[]。
 *
 * 两个必须兼容的情况：
 * 1. ConvertTo-Json 在只有一条记录时输出**裸对象**而不是数组，不处理直接 .map 会炸；
 * 2. 一个用户都没匹配到时脚本输出空串，JSON.parse('') 会抛 SyntaxError。
 *
 * @throws {SyntaxError} stdout 不是合法 JSON（PowerShell 把警告混进 stdout 时会走到这里）
 */
export function parseLocalUsers(stdout: string): LocalUser[] {
  const text = stdout.trim()
  if (!text) {
    return []
  }

  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : [parsed]

  return list.map((item): LocalUser => {
    const raw = (item ?? {}) as RawLocalUser
    return {
      name: toText(raw.Name),
      displayName: toText(raw.DisplayName),
      enabled: raw.Enabled === true,
      principalSource: toText(raw.PrincipalSource),
      sid: toText(raw.SID),
      isAdmin: raw.IsAdmin === true,
      lastLogon: toText(raw.LastLogon),
      description: toText(raw.Description)
    }
  })
}

/**
 * 纯函数：从 SID 里取末段 RID 当用户 id（`S-1-5-21-...-1001` → 1001）。
 *
 * 用 RID 而不是数组下标：下标会随排序 / 过滤变化，RID 是账户自身的属性，稳定且唯一。
 * 取不到数字时返回 0（渲染层只拿它当 React key，不需要区分「没有 SID」和「RID 恰好是 0」）。
 */
export function parseSidRid(sid: string): number {
  const tail = sid.trim().split('-').pop() ?? ''
  // Number('') === 0，空串会被误判成合法数字，所以单独挡一下
  if (!tail) {
    return 0
  }

  const rid = Number(tail)
  return Number.isFinite(rid) ? rid : 0
}

/** 执行一段 PowerShell 并返回 stdout（已 trim） */
export function runPowerShell(command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', `${UTF8_PREFIX} ${command}`],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout.trim())
      }
    )
  })
}

/**
 * 把调用方给的脚本标识解析成可直接交给 PowerShell 的绝对路径。
 *
 * 支持四种写法，调用方不需要关心脚本目录在哪：
 *
 * | 入参                    | 解析结果                      | 说明                        |
 * | ----------------------- | ----------------------------- | --------------------------- |
 * | `'check-is-admin'`      | `<PS_DIR>/check-is-admin.ps1` | 省略扩展名，自动补 `.ps1`   |
 * | `'check-is-admin.ps1'`  | `<PS_DIR>/check-is-admin.ps1` | PS_DIR 下的文件名           |
 * | `'sub/report.ps1'`      | `<PS_DIR>/sub/report.ps1`     | PS_DIR 下的子目录           |
 * | `'D:\\scripts\\x.ps1'`  | `D:\scripts\x.ps1`            | 绝对路径不拼 PS_DIR（含 UNC）|
 *
 * `<PS_DIR>` 由 {@link getPsDir} 定位（开发态 `<项目根>/resources/ps`，安装态 asar.unpacked 同名目录）。
 *
 * 返回值一律是 normalize 过的绝对路径（Windows 反斜杠分隔）。
 * 只做「补扩展名 + 拼路径」，**不校验文件是否存在**，存在性交给 runPsScript 检查。
 * 显式传 psDir 时本函数是纯函数（单测走这条路）；省略时才会由 getPsDir 做一次目录探测。
 *
 * @param scriptFile 脚本标识，写法见上表
 * @param psDir 相对标识的基准目录，默认 {@link getPsDir} 的结果；绝对路径入参会忽略它
 * @throws {TypeError} 入参为空或只有空白字符
 */
export function resolvePsScriptPath(scriptFile: string, psDir: string = getPsDir()): string {
  const name = scriptFile.trim()
  if (!name) {
    throw new TypeError('resolvePsScriptPath: 脚本名不能为空')
  }

  // 扩展名大小写不敏感（.PS1 / .Ps1 都认），已经带了就不重复补
  const withExt = name.toLowerCase().endsWith(PS_SCRIPT_EXT) ? name : `${name}${PS_SCRIPT_EXT}`

  // 绝对路径（Windows 盘符 `D:\`、POSIX `/`、UNC `\\server\share`）不再拼 psDir，否则路径就废了。
  // normalize 统一分隔符并归一 `.` / `..`，让两个分支的返回值风格一致（join 本身已 normalize）
  return normalize(isAbsolute(withExt) ? withExt : join(psDir, withExt))
}

/**
 * 用 `powershell` 包执行一个 .ps1 脚本，返回 stdout / stderr / 退出码。
 *
 * @param scriptFile 脚本标识，写法见 {@link resolvePsScriptPath}：
 *   `'check-is-admin'` / `'check-is-admin.ps1'` / `'sub/x.ps1'` / `'D:\\scripts\\x.ps1'` 都可以。
 *
 * 四个必须注意的点（原来那行 `new PowerShell('../ps/check-is-admin.ps1')` 前三个都中了）：
 * 1. 该包把入参拼成 `-Command "& {<input>}"`，相对路径是按 **process.cwd()** 解析的，
 *    不是按本文件位置。`electron .` 的 cwd 是包根目录，'../ps/x.ps1' 会指到包外面，
 *    PowerShell 直接报 "The term '../ps/x.ps1' is not recognized..."，所以统一解析成绝对路径。
 * 2. 绝对路径可能含空格，必须写成 `& '<path>'` 交给调用运算符，不能把路径裸放进去。
 * 3. stdout 不是流式的：'output' 在子进程 close 时才带全量字符串触发一次；
 *    而报错信息只走 stderr（'error-output'），只监听 'output' 就会被静默吞掉，看起来像"没运行"。
 * 4. 路径解析放在 Promise executor 里做：resolvePsScriptPath 抛的 TypeError 会自动转成
 *    rejection，不会变成调用方接不住的同步异常。
 */
export function runPsScript(scriptFile: string): Promise<PsScriptResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = resolvePsScriptPath(scriptFile)
    if (!existsSync(scriptPath)) {
      // 把全部候选目录一起打出来：这类错误九成是「脚本没跟着产物走」，
      // 只报一个路径看不出到底是目录没定位对，还是脚本文件真的缺了
      reject(
        new Error(
          `PowerShell 脚本不存在: ${scriptPath}（入参: '${scriptFile}'）\n` +
            `已探测的 ps 目录: ${PS_DIR_CANDIDATES.join(' | ')}`
        )
      )
      return
    }

    let stdout = ''
    let stderr = ''
    // Bypass：目标机器执行策略若是 Restricted，不加这个参数脚本会被直接拦下
    const ps = new PowerShell(`& '${scriptPath}'`, { executionpolicy: 'Bypass' })

    // powershell.exe 起不来（不在 PATH 等）时走这里
    ps.on('error', (error: Error) => {
      reject(error)
    })
    ps.on('error-output', (data: string) => {
      stderr += data
    })
    ps.on('output', (data: string) => {
      stdout = data
    })
    // 'output' 之后才触发 'end'，在这里 resolve 才能拿到完整 stdout
    ps.on('end', (code: number | null) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })
  })
}

/** 采集 Windows 11 系统信息：WMI 部分走 PowerShell，运行时版本号直接取 process.versions */
export async function collectSystemInfo(): Promise<SystemInfo> {
  const raw = await runPowerShell(SYSTEM_INFO_SCRIPT)

  return {
    ...parseSystemInfoFromOs(raw),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    chrome: process.versions.chrome ?? ''
  }
}

/**
 * 取本机「已启用、非内置」的本地用户列表。
 *
 * 权限不足时它不会让进程非零退出，只往 stderr 写 Access denied，所以这里靠 stderr 判别，
 * 不能只看退出码。
 */
export async function getLocalUsers(): Promise<LocalUser[]> {
  const { stdout, stderr, code } = await runPsScript('get-local-users.ps1')

  if (!stdout) {
    // stdout 为空有两种可能：确实没有符合条件的用户（正常），或脚本报错（异常）
    if (stderr || (code !== null && code !== 0)) {
      throw new Error(`get-local-users.ps1 执行失败(exit=${String(code)}): ${stderr || '无输出'}`)
    }
    return []
  }

  try {
    return parseLocalUsers(stdout)
  } catch (error) {
    throw new Error(`get-local-users.ps1 输出不是合法 JSON: ${toErrorMessage(error)}`, {
      cause: error
    })
  }
}

export function lockScreen(): void {
  spawn('rundll32.exe', ['user32.dll,LockWorkStation'], {
    windowsHide: true,
    detached: true, // 立即脱离，不等它返回
    stdio: 'ignore'
  }).unref()
}

export const getYearMonthDay = (value: unknown = Date.now()) => {
  if (value instanceof Date || typeof value === 'number') {
    return new Date(value).toLocaleDateString()
  }
  return value
}

export const isSameDate = (val1: unknown, val2: unknown) => {
  if (
    (val1 instanceof Date || typeof val1 === 'number') &&
    (val2 instanceof Date || typeof val2 === 'number')
  ) {
    return new Date(val1).toLocaleDateString() === new Date(val2).toLocaleDateString()
  }
  return false
}
