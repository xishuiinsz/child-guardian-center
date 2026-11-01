/**
 * README「打包要求」的一键安装入口：产出「单个 .exe」+ 注册 Windows 计划任务。
 *
 * 用法（在 package.json 里注册为 install:app）：
 *   npm run install:app                     打包 + 复制 + 注册任务（需要时自动弹一次 UAC）
 *   npm run install:app -- --user child     只在 child 账户登录时触发，并以该账户身份运行
 *   npm run install:app -- --dry-run        只打印将要注册的任务定义，不改动系统
 *   npm run install:app -- --no-task        只打包出单个 exe，不注册任务
 *   npm run install:app -- --skip-build     跳过打包，用 dist 里已有的产物注册任务
 *   npm run install:app -- --list-users     列出本机可管控的本地账户（复用 get-local-users.ps1）
 *   npm run uninstall:app                   停止并删除任务、删除安装目录
 *
 * 为什么脚本名不叫 install：
 *   install 是 npm 的保留生命周期名，实测 `npm install` / `npm ci` / `npm i <pkg>` 都会顺带触发它，
 *   且它跑在 postinstall（install-electron 下载 Electron 二进制）之前 —— 全新克隆时必然打包失败。
 *   所以改名 install:app，只由人显式调用。
 *
 * 为什么用 .mjs 而不是 .ts：
 *   构建脚本不进 tsconfig 的任何 program（include 只覆盖 src/**），写成纯 JS 才能被 Node 22 直接跑，
 *   不必为它引入 tsx / ts-node 之类的新依赖。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 需求里写死的任务名，同时也是产物名与安装目录名 */
const TASK_NAME = 'child-guardian-center'
/** electron-builder.yml 里 portable.artifactName = ${name}.exe，产物名恒定（不带版本号） */
const ARTIFACT_PATH = join(ROOT, 'dist', `${TASK_NAME}.exe`)
/** 任务实际指向的安装目录：不能指向 dist\，产物名与 git clean 都会让任务路径失效 */
const DEFAULT_INSTALL_DIR = join(process.env.ProgramFiles ?? 'C:\\Program Files', TASK_NAME)

/**
 * 一律用 Win11 自带的 Windows PowerShell 5.1（路径固定），不依赖目标机器装没装 pwsh。
 * 与 src/utils/index.ts 里的 POWERSHELL_EXE 保持同一个取值。
 * 注意：5.1 读无 BOM 的 UTF-8 脚本会按 ANSI(GBK) 解码，所以 setup-task.ps1 必须带 BOM。
 */
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const SETUP_TASK_PS1 = join(ROOT, 'scripts', 'setup-task.ps1')
const CHECK_IS_ADMIN_PS1 = join(ROOT, 'resources', 'ps', 'check-is-admin.ps1')
const GET_LOCAL_USERS_PS1 = join(ROOT, 'resources', 'ps', 'get-local-users.ps1')
const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ELECTRON_INSTALL_JS = join(ROOT, 'node_modules', 'electron', 'install.js')

/**
 * 同步等待若干毫秒。
 * 用 Atomics.wait 而不是再起一个 node 子进程 setTimeout：没有额外进程开销，也不会被 Ctrl+C 之外的信号打断。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** UAC 提权被用户取消时的退出码（Windows ERROR_CANCELLED） */
const EXIT_USER_CANCELLED = 1223

/**
 * 打包失败时的排查提示。
 *
 * 写死在这里而不是等出问题再现查：本项目打包唯一的外部依赖是「首次构建要联网下载的二进制」，
 * 报错栈长得很像代码 bug（一堆 node:internal/streams 与 node:dns），实际与业务代码无关。
 */
const BUILD_FAIL_HINT = `
排查提示（打包失败的常见原因）:
  1. 栈里出现 node:dns / getaddrinfo / GetAddrInfoReqWrap
     → 下载外部二进制时 DNS 解析失败，不是本项目代码问题。electron-builder 首次打包需要下载：
         electron zip（约 151MB）        <- electron-builder.yml 的 electronDownload.mirror（已指向 npmmirror）
         nsis / nsis-resources / 7zip    <- .npmrc 的 electron_builder_binaries_mirror（已指向 npmmirror）
       下载成功后会缓存到 %LOCALAPPDATA%\\electron\\Cache 与 %LOCALAPPDATA%\\electron-builder\\Cache，
       之后的打包不再联网。切换网络 / 关掉失效代理后重跑即可。
       注：产物是未签名的（没配证书），日志里的 "signing with signtool.exe" 不代表会去下载 winCodeSign。
  2. 想看全到底是哪个域名解析失败：把完整输出重定向到【项目目录之外】的文件再看
         npm run build:portable > %TEMP%\\cgc-build.log 2>&1
     千万别重定向到项目目录内：electron-builder 是「先枚举文件算 asar 偏移、再逐个写内容」，
     构建期间还在增长的日志会把其后所有文件的偏移顶歪，产出一个「能列目录、但读出来是别的文件内容」
     的坏 asar，表现为 exe 启动即退出（exit 1）且没有任何输出。
  3. 报错里出现 EBUSY / resource busy or locked, unlink '...\\dist\\win-unpacked\\resources\\app.asar'
     → 有进程占着上一次的构建产物。实测最常见的占用者是 **Visual Studio Code 本身**
       （用 Restart Manager 查出来是 "Visual Studio Code"，它监视/索引了 dist 目录）。
       处理：在 VS Code 里执行「Developer: Reload Window」重载窗口（或构建期间关掉 VS Code），再重跑。
       本仓库已在 .vscode/settings.json 里把 dist / out 排除出 files.watcherExclude 与 search.exclude，
       重载窗口后生效，可降低复发概率。
       想自己确认是谁占的，可用 Restart Manager API（Get-Process 看不到这种数据文件句柄）。
  4. 报错里出现 EPERM / EACCES 且路径在 dist\\
     → 上一次启动的 child-guardian-center.exe 还没退干净：先 Stop-ScheduledTask -TaskName child-guardian-center，
       再 taskkill /IM child-guardian-center.exe /T /F。
`

/**
 * 构建前预检：确认上一次的 app.asar 没被别的进程占用。
 *
 * 为什么要专门查这个：electron-builder 打包时会先 unlink 旧的 app.asar，被占用就报
 * `EBUSY: resource busy or locked`。而这个错误要等到 typecheck + vite build + 解包 electron
 * 全跑完（约 1~2 分钟）才出现，报错栈里也看不出是谁占的 —— 提前 1 秒查出来更省事。
 *
 * 为什么不能用 Node 的 fs 去试：libuv 打开文件时默认带
 * FILE_SHARE_READ|WRITE|DELETE，即使别人占着也能打开成功，测不出来。
 * 所以借 PowerShell 的 [IO.File]::Open(..., FileShare.None) 做一次真正的独占探测。
 *
 * 独占失败也可能是杀软正在扫描（几秒内会释放），所以重试 3 次再判定为「真被占用」。
 */
function assertAsarNotLocked() {
  const asarPath = join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')
  if (!existsSync(asarPath)) return

  const probe = `try { $f = [IO.File]::Open('${asarPath}', 'Open', 'ReadWrite', 'None'); $f.Close(); exit 0 } catch { exit 1 }`
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', probe], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true
    })
    if (result.status === 0) return
    if (attempt < 3) sleepSync(2000)
  }

  fail(
    `dist\\win-unpacked\\resources\\app.asar 被其他进程占用，打包会在 unlink 这一步报 EBUSY。\n` +
      `    实测最常见的占用者是 Visual Studio Code（它监视/索引了 dist）。\n` +
      `    请在 VS Code 里执行「Developer: Reload Window」后重跑，或构建期间先关掉 VS Code。\n` +
      `    确认产物已无用时也可以直接删掉 dist 目录再打包。`
  )
}

const HELP = `
用法: npm run install:app -- [选项]

选项:
  --user <name>    只在指定账户登录时触发，并以该账户身份运行（留空 = 任何用户登录，跟随登录用户）
  --dest <dir>     exe 安装目录，默认 ${DEFAULT_INSTALL_DIR}
  --skip-build     跳过打包，直接用 dist 里已有的产物注册任务
  --no-task        只打包出单个 exe，不注册计划任务（CI 用）
  --dry-run        只打印将要注册的任务定义，不改动系统（也不需要管理员权限）
  --list-users     列出本机可管控的本地账户后退出
  -h, --help       显示本帮助
`

/** 打印错误并以退出码 1 结束，避免调用方（npm）拿到 0 却什么都没做成 */
function fail(message) {
  console.error(`[X] ${message}`)
  process.exit(1)
}

/** 解析命令行参数：项目没装 minimist/yargs，几个 flag 手写 switch 就够，不为此加依赖 */
function parseArgs(argv) {
  const opts = {
    user: '',
    dest: DEFAULT_INSTALL_DIR,
    skipBuild: false,
    noTask: false,
    uninstall: false,
    dryRun: false,
    listUsers: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--user':
        opts.user = argv[++i] ?? ''
        if (!opts.user) fail('--user 需要一个账户名，例如 --user child')
        break
      case '--dest':
        opts.dest = resolve(argv[++i] ?? opts.dest)
        break
      case '--skip-build':
        opts.skipBuild = true
        break
      case '--no-task':
        opts.noTask = true
        break
      case '--uninstall':
        opts.uninstall = true
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--list-users':
        opts.listUsers = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        fail(`未知参数：${arg}（npm run install:app -- --help 看用法）`)
    }
  }

  return opts
}

/**
 * 跑 npm 脚本。
 *
 * Windows 上 Node 18.20+ 出于安全考虑禁止不带 shell 直接 spawn .cmd/.bat（会抛 EINVAL），
 * 所以这里必须 shell:true。前提是被调用的参数里不含空格与引号 —— 只传 'run' + 脚本名，成立。
 */
function runNpm(args) {
  const result = spawnSync('npm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) fail(`npm ${args.join(' ')} 启动失败：${result.error.message}`)
  return result.status ?? 1
}

/**
 * 跑 powershell.exe。
 *
 * 这里反过来必须 shell:false：参数里有含空格的绝对路径（Program Files、用户名带空格等），
 * shell:false 时 Node 会自己按 CreateProcess 的规则加引号，比手拼 cmd 命令行安全。
 */
function runPowershell(psArgs, options = {}) {
  const result = spawnSync(POWERSHELL_EXE, psArgs, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.error) fail(`powershell 启动失败：${result.error.message}`)
  return result.status ?? 1
}

/** 复用项目已有的 check-is-admin.ps1：输出 True/False，只认字面量 true */
function isAdmin() {
  const result = spawnSync(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CHECK_IS_ADMIN_PS1],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  return (result.stdout ?? '').trim().toLowerCase() === 'true'
}

/**
 * 弹一次 UAC，用提权后的 PowerShell 执行 setup-task.ps1，并把它的退出码原样带回来。
 *
 * 为什么先落一个临时 .ps1 再 -File 调用，而不是直接 -Command "<Start-Process ...>"：
 * -Command 的字符串要经过 Node 的 CreateProcess 转义 + PowerShell 自己的解析两层，
 * 里面还嵌着含空格的路径，引号极易被吃掉。写成脚本文件后，传给 powershell 的只有纯路径参数，
 * 内层引号完全由本函数用 PowerShell 的单引号字面量规则（' 双写）控制，可预测得多。
 *
 * 临时脚本带 UTF-8 BOM 写出：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，
 * 路径里出现中文（例如中文用户名）时会变成乱码而找不到文件。
 */
function runElevated(psArgs) {
  const literals = psArgs.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(', ')
  const wrapper = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `    $p = Start-Process -FilePath '${POWERSHELL_EXE}' -Verb RunAs -Wait -PassThru -ArgumentList @(${literals})`,
    '} catch {',
    '    Write-Host "[X] 提权失败或被取消：$($_.Exception.Message)"',
    `    exit ${EXIT_USER_CANCELLED}`,
    '}',
    'if ($null -eq $p.ExitCode) { exit 1 }',
    'exit $p.ExitCode',
    ''
  ].join('\n')

  const wrapperPath = join(tmpdir(), `${TASK_NAME}-elevate-${process.pid}.ps1`)
  writeFileSync(wrapperPath, `\uFEFF${wrapper}`, 'utf8')

  console.log('[i] 当前终端不是管理员权限，将弹一次 UAC 用于注册计划任务与写入安装目录…')
  try {
    const code = runPowershell([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      wrapperPath
    ])
    if (code === EXIT_USER_CANCELLED) {
      fail('UAC 被取消，计划任务未注册。可改为在「以管理员身份运行」的终端里重跑本命令。')
    }
    return code
  } finally {
    rmSync(wrapperPath, { force: true })
  }
}

/** 非管理员则自动提权执行；DryRun 不改系统，直接就地跑 */
function runSetupTask(psArgs, allowElevate) {
  if (!allowElevate || isAdmin()) {
    return runPowershell(psArgs)
  }
  return runElevated(psArgs)
}

/**
 * 确保 Electron 二进制已下载。
 *
 * 顺序坑：npm 的 install 生命周期早于 postinstall，而 Electron 的 dist 是靠
 * `postinstall: install-electron` 下载的。全新克隆时若直接打包，electron-builder 会因为
 * 找不到 electron.exe 而失败 —— 所以这里幂等地补跑一次官方安装脚本。
 */
function ensureElectronBinary() {
  if (existsSync(ELECTRON_DIST)) return

  console.log('[i] 未发现 Electron 二进制，先执行 install.js 下载…')
  if (!existsSync(ELECTRON_INSTALL_JS)) {
    fail(`找不到 ${ELECTRON_INSTALL_JS}，请先执行 npm install`)
  }
  const result = spawnSync(process.execPath, [ELECTRON_INSTALL_JS], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (result.status !== 0) fail('Electron 二进制下载失败，无法打包')
}

/** 把产物大小打印出来：单个 exe 约 100MB+，异常偏小说明运行时没打进去 */
function describeArtifact(path) {
  const sizeMb = (statSync(path).size / 1024 / 1024).toFixed(1)
  return `${path}（${sizeMb} MB）`
}

/** powershell.exe 的固定前缀参数：不读用户 profile、不交互、放开脚本执行策略 */
const PS_INVOKE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) {
    console.log(HELP)
    return 0
  }
  if (process.platform !== 'win32') {
    fail('本命令只支持 Windows：要注册的是 Windows 任务计划程序（Task Scheduler）')
  }
  if (!existsSync(POWERSHELL_EXE)) {
    fail(`找不到 Windows PowerShell：${POWERSHELL_EXE}`)
  }

  // 列出可管控的本地账户：给 --user 提供候选值。
  // 直接复用主进程的 get-local-users.ps1，避免「安装时看到的用户」和「运行时看到的用户」两套口径。
  if (opts.listUsers) {
    return runPowershell([...PS_INVOKE, GET_LOCAL_USERS_PS1])
  }

  const taskArgs = [...PS_INVOKE, SETUP_TASK_PS1, '-TaskName', TASK_NAME, '-InstallDir', opts.dest]

  if (opts.uninstall) {
    const args = [...taskArgs, '-Uninstall']
    if (opts.dryRun) args.push('-DryRun')
    // DryRun 不改动系统，没必要为它弹 UAC
    return runSetupTask(args, !opts.dryRun)
  }

  // ---- 第一步：产出单个 .exe ----
  if (!opts.skipBuild) {
    assertAsarNotLocked()
    ensureElectronBinary()
    const code = runNpm(['run', 'build:portable'])
    if (code !== 0) {
      // 先给排查线索再退出：electron-builder 的报错栈全是 node 内部帧，看不出是网络问题还是代码问题
      console.error(BUILD_FAIL_HINT)
      fail('打包失败，已终止（未注册计划任务，系统状态未被改动）')
    }
  }

  if (!existsSync(ARTIFACT_PATH)) {
    fail(`未找到打包产物：${ARTIFACT_PATH}\n    请先执行 npm run build:portable`)
  }
  console.log(`[OK] 单个 exe 已生成：${describeArtifact(ARTIFACT_PATH)}`)

  if (opts.noTask) {
    console.log('[i] --no-task：跳过计划任务注册')
    return 0
  }

  // ---- 第二步：复制到固定目录并注册计划任务（需要管理员权限） ----
  const args = [...taskArgs, '-SourceExe', ARTIFACT_PATH]
  if (opts.user) args.push('-User', opts.user)
  if (opts.dryRun) args.push('-DryRun')
  return runSetupTask(args, !opts.dryRun)
}

// 用 exitCode 而不是 process.exit()：后者会在 stdio 未 flush 时截断子进程的输出
process.exitCode = main()
