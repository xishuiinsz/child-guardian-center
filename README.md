# child-guardian-center

## 核心需求

- 本程序的目标是管控作为普通用户的孩童单次使用电脑的时长，并强制休息数倍于使用电脑时长的时间。
- 本程序分多个版本实现
- 迭代一版本主要能力：
  - 硬编码初始化用户的可用时长及禁用倍数
  - 以用户为维度，定义`UserTiming`接口，接口定义如下
  - status，字符串类型，表示当前用户是可用状态或禁用状态
  - countdown, 数字类型，表示当前用户在当前状态下的剩余时长
  - lastTime, 数字类型，时间戳格式，表示当前用户在当前状态下的时间点
  - countdown -=  Date.now() - lastTime，表示触发一次定时器减去时间差
  - 编写overTimeCheck函数，处理锁屏、定时器、更新状态等
  - 监听锁屏事件，在回调中停止定时器
  - 监听解锁事件，在回调中重新调用overTimeCheck

- 设计分析：
  - 计时模型是「墙上时钟差值」，不是「定时器累加」：`setTimeout` 只作 1 秒节拍（`delay`）触发，
    每拍都按 `countdown -= Math.max(0, Date.now() - lastTime)` 扣真实流逝时间。
    `setTimeout` 本身不保证精度，用固定 `delay` 扣减会被抖动/漏拍累积成误差，用差值扣减则不会。
    `Math.max` 兜住系统时钟回拨，回拨时这一拍不扣、而不是倒加时长。
  - 停表 / 起表以 `status`（available / disabled）为准，锁屏只决定「可用状态下要不要停表」：
    - 可用 + 锁屏 → `pauseTimer()`：清定时器**并把 `lastTime` 推到当前**，丢弃锁屏这段间隔。
      只清定时器不改 `lastTime` 的话，下次起表会把停表期间一次性倒扣（锁屏 10 分钟 = 白扣 10 分钟）。
    - 强制休息 + 锁屏 → **继续计时**，且每拍重复调用 `lockScreen()`。
      休息期间屏幕本来就是锁着的，此时停表等于让孩子一锁屏就把休息时间「冻住」。
    - 强制休息在锁屏中自然结束 → 切回 available 那一刻补一次 `pauseTimer()`，等解锁再起表，
      否则刚拿回来的额度会在没人用电脑的时候白白烧掉，甚至烧到触发下一轮休息。
    - 首轮起表前先把 `lastTime` 推到 app ready：模块加载到 ready 之间的耗时
      （portable 版解压可达约 9 秒）不该算进孩子的可用时长。
  - **不保存锁屏状态**：`cachedData` 里只有去重用的 `lastSessionEvent`，没有「屏幕是否锁着」字段。
    锁屏状态只在事件到达的那一刻有用，当场消费完就丢：
    - `lock-screen` → 若 `status === available` 就 `pauseTimer()`。停表就是锁屏对计时系统的全部影响。
    - `unlock-screen` → `resumeTiming(true)`，把「孩子在电脑前」直接透传进 `overTimeCheck`。
    - `overTimeCheck(present)` 只在「强制休息结束 → 切回 available」这一个分支读 `present`：
      不在场就停表等解锁，否则刚发下来的额度会在没人用时白白烧掉、甚至烧到又触发下一轮休息。
      定时器 tick 一律传 `false` —— tick 能走进那个分支说明当时是 disabled，而休息期间的屏幕
      是本项目自己锁的且每拍重锁，孩子必然不在场；available 状态下走不到这个分支，故不影响正常计时。
    - 沿革：最早用单个 `isLocked` 兼「去重标志」与「锁屏状态源」两职；先拆成
      `screenLocked` + `lastSessionEvent`，再把锁屏状态改成 `overTimeCheck(present)` 的调用点断言，
      `screenLocked` 随之删除。顺带消掉一条隐式契约 —— 旧版 unlock 回调必须「先清状态再走检查」，
      顺序写反就会白白停一次表；现在没有共享状态，也就没有顺序陷阱。
  - `cachedData.lastSessionEvent` 只服务于去重，不参与任何计时判断。
    锁屏 / 解锁事件可能瞬时连发两次，`acceptSessionEvent(type)` 用「上一次处理的事件类型 + 时间戳」
    判重：同类型且间隔小于 `SESSION_EVENT_DEDUP_MS`（500ms）就丢弃，避免同一次锁屏被结算两遍
    （重复 `pauseTimer()` / `resumeTiming()` 会反复重置 `lastTime`，也会多跑一次 `lockScreen()`）。
    类型不同则照常放行，所以 lock → unlock → lock 这种真实交替不会被误挡。
  - 解锁统一走 `resumeTiming(true)`（重置 `lastTime` → `clearTimer()` → `overTimeCheck(true)`），
    由 `overTimeCheck` 决定接下来是继续用、还是 `disabled` 分支立刻锁回去，回调自身不判状态。
    旧写法按「解锁那一刻的 status」决定要不要锁回去，休息刚好在这一拍结束时会多锁一次。
  - `suspend` / `resume`：睡眠期间定时器不触发，`suspend` 里显式 `pauseTimer()`，
    否则整段睡眠会被算成已用时长。`resume` 唤醒后一律 `resumeTiming(true)` ——
    因为不保存锁屏状态，唤醒时无从得知屏幕锁没锁，取舍见下方「已知限制」。
  - 定时器只在 `overTimeCheck` 末尾排一次，且排之前先 `clearTimer`：
    任何路径重复调用本函数都不会叠出两个定时器。历史上「休息结束切回 available 后不再续期」
    的写法会导致第一轮跑完后计时永久停摆，孩子此后可以无限期使用电脑。
  
- 打包要求:
  - 在package.json文件中新建一个install命令，功能如下
    - 生成单一的.exe文件
    - 在winows任务计划程序中生成一个任务，名称为child-guardian-center
    - 只在用户登录时运行，使用最高权限权限运行
      操作为启动程序，程序或脚本指向生成.exe文件
  - 实现说明（已落地，命令名与原描述有一处偏差）:
    - 命令名用的是 `install:app` 而不是 `install`：`install` 是 npm 保留的生命周期脚本名，
      `npm install` / `npm ci` / 装任意新依赖都会顺带触发它；而且它跑在 `postinstall`
      （`install-electron` 下载 Electron 二进制）之前，全新克隆执行 `npm install` 时必然打包失败。
    - 「单一的 .exe」由 electron-builder 的 `portable` 目标产出：Electron 应用无法编译成真·单文件
      （必须携带 Chromium 运行时），portable 是 NSIS 自解压外壳，启动时解压到 `%TEMP%\child-guardian-center`。
    - 安装编排见 `scripts/install-app.mjs`，任务注册见 `scripts/setup-task.ps1`。

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

### Install（打包成单个 exe + 注册开机自启任务，仅 Windows）

把应用打包成单个 `.exe`，复制到 `C:\Program Files\child-guardian-center\`，
并在任务计划程序里注册名为 `child-guardian-center` 的任务（登录时启动、最高权限）。
注册任务需要管理员权限：终端未提权时脚本会自动弹一次 UAC。

```bash
# 打包 + 复制 + 注册任务（任何用户登录都触发，以「登录用户本人」身份运行）
$ npm run install:app

# 只在指定账户登录时触发，并以该账户身份运行
$ npm run install:app -- --user child

# 只打印将要注册的任务定义，不改动系统（也不需要管理员权限）
$ npm run install:app -- --dry-run

# 列出本机可管控的本地账户，作为 --user 的候选值
$ npm run install:app -- --list-users

# 只打包出单个 exe（dist\child-guardian-center.exe），不注册任务
$ npm run build:portable

# 停止并删除任务、删除安装目录
$ npm run uninstall:app
```

打包失败的两个高频原因（`npm run install:app` 失败时会直接打印完整排查提示）：

- `EBUSY: resource busy or locked, unlink '...\dist\win-unpacked\resources\app.asar'`
  → **VS Code 占用了上一次的构建产物**（用 Restart Manager 查出来占用者就是 Visual Studio Code，
  `Get-Process` 看不到这种数据文件句柄）。在 VS Code 里执行「Developer: Reload Window」后重跑。
  `.vscode/settings.json` 已把 `dist` / `out` 排除出 `files.watcherExclude` 与 `search.exclude`，重载后生效。
  `install-app.mjs` 会在构建前做一次独占探测，命中就秒级失败并给出提示，不用白等两分钟。
- 报错栈里是 `node:dns` / `getaddrinfo` / `GetAddrInfoReqWrap`
  → 首次打包要联网下载外部二进制（electron zip 约 151MB 走 `electron-builder.yml` 的 `electronDownload.mirror`；
  nsis / nsis-resources / 7zip 走 `.npmrc` 的 `electron_builder_binaries_mirror`，均已指向 npmmirror），
  DNS 解析失败就报这个。换网络 / 关掉失效代理后重跑；下载成功即缓存到
  `%LOCALAPPDATA%\electron\Cache` 与 `%LOCALAPPDATA%\electron-builder\Cache`，之后打包不再联网。
  注意排查时**不要把构建日志重定向到项目目录内**：electron-builder 先枚举文件算 asar 偏移、再逐个写内容，
  构建期间仍在增长的日志会把偏移顶歪，产出「能列目录但读出来是别的文件内容」的坏 asar，
  表现为 exe 启动即退出（exit 1）且无任何输出。日志请写到 `%TEMP%`。

脚本显式覆盖了几个 Task Scheduler 默认值 —— 不改的话任务「装好了但不会生效」：

| 设置项                     | 系统默认值                 | 本脚本设为                 |
| -------------------------- | -------------------------- | -------------------------- |
| DisallowStartIfOnBatteries | true（笔记本不插电不启动） | false                      |
| StopIfGoingOnBatteries     | true                       | false                      |
| ExecutionTimeLimit         | PT72H（跑满 3 天被强杀）   | PT0S（不限制）             |
| MultipleInstances          | Parallel                   | IgnoreNew（防重复启动）    |
| RestartOnFailure           | 关                         | 失败后重试 3 次，间隔 1 分 |

已知限制：

- **「最高权限」对标准用户不会真提权**：`RunLevel=Highest` 的语义是「用该账户可用的最高令牌」，
  孩子若是标准用户，进程仍然是非提权的。迭代一的计时与锁屏不需要管理员权限，但
  `get-local-users.ps1` 在标准用户下有 Access denied 风险，需要在孩子账户上实测。
- **任务必须以「登录用户本人」身份运行**：`lockScreen()` 走 `rundll32 user32.dll,LockWorkStation`，
  只能锁「本进程所在的会话」。以家长账户身份运行、却在孩子登录时触发，会锁错会话（锁不到孩子）。
  因此未指定 `--user` 时用 Users 组 SID（`S-1-5-32-545`）作 principal（cmdlet 会自动落成
  `LogonType=Group`，语义就是「谁登录就以谁的身份、在谁的交互会话里运行」）；
  指定 `--user` 时用 `UserId + LogonType Interactive`。
  注意 `New-ScheduledTaskPrincipal` 的 Group 参数集不接受 `-LogonType`，传了会报 AmbiguousParameterSet。
- **任务指向安装目录而不是 `dist\`**：`dist` 下的产物带版本号、且 `git clean` 会清掉，
  路径一旦失效，孩子登录后什么都不会发生且不报错。所以 `portable.artifactName` 固定为不带版本号的
  `child-guardian-center.exe`，并由脚本复制到 `Program Files`。
- **portable 的固有代价（已实测）**：单文件 exe 96.3 MB，每次启动都要把约 372 MB 解压到
  `%TEMP%\child-guardian-center`，本机实测「启动 → 主进程就绪」约 **9 秒**（正常退出时自动清理该目录，
  被 `taskkill /F` 强杀则残留）。也就是说孩子登录后约 9 秒才开始计时 —— 若这个延迟不可接受，
  替代方案是改用 `npm run build:win`（nsis 安装版）并让任务指向安装后的 exe，无解压延迟，
  但产物就不是「单一 exe」了，与需求冲突，故默认仍用 portable。
  另外：portable 不支持 electron-updater 自动更新；未签名 exe 首次运行可能被 SmartScreen 拦；
  计划任务的「停止」只会杀掉外壳 stub，脚本里已用 `Stop-Process` 兜底清理残留进程。
- **孩子仍可在任务管理器里结束进程**（标准用户无权改任务本身，但能结束自己的进程）。
  脚本已配置失败自动重启 3 次；要真正防篡改需要改成 Windows 服务或加进程保护，属后续迭代。
- **唤醒后可能白烧额度（方案 3 的已知取舍）**：本项目不保存锁屏状态，`resume` 回调无从得知
  屏幕是锁着还是开着，一律按「孩子在电脑前」处理并 `resumeTiming(true)`。
  若睡眠前屏幕是锁着的、且系统未配置「唤醒时需要登录」，那么从唤醒到孩子真正解锁的这段时间
  会被算进可用时长 —— 孩子回来时可能发现额度变少，甚至正好落在强制休息里被再锁一次。
  Modern Standby 机器会周期性自动唤醒，会放大这个窗口。
  之所以不选「唤醒后保持停表、等解锁再起」：那种做法在「睡眠前屏幕是开着的」场景下永远等不到
  `unlock-screen` 事件，计时会永久停摆（对孩子等于无限时长，管控彻底失效）。
  两边都 fail-open 时选失控窗口小的那个。彻底解决需要持久化 + 权威锁屏状态查询，属后续迭代。
  缓解办法（不改代码）：把 Windows「登录选项 → 需要登录」设为「始终」，
  这样唤醒必然经过一次解锁，`unlock-screen` 会重新校准计时。
