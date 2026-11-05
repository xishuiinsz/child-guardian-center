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
