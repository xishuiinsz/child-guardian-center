<#
.SYNOPSIS
    注册 / 卸载 child-guardian-center 的 Windows 计划任务（需要管理员权限）。

.DESCRIPTION
    对应 README「打包要求」的后三条：
      * 任务名称 child-guardian-center
      * 只在用户登录时运行（触发器 AtLogOn）
      * 使用最高权限运行（Principal RunLevel = Highest）
      * 操作为启动程序，指向打包出来的单个 .exe

    为什么用 Register-ScheduledTask 而不是 schtasks.exe：
        schtasks 的 /SC ONLOGON 无法表达「限定哪个账户登录才触发」和「LogonType = Interactive」。
        而这两点是本项目的硬需求：主进程的 lockScreen() 走 rundll32 user32.dll,LockWorkStation，
        只能锁「本进程所在的会话」。任务若以家长账户身份运行、却在孩子登录时被触发，
        进程会落在家长的会话（或 session 0），锁屏根本锁不到孩子。

    关于「最高权限」的一个事实（别踩）：
        RunLevel = Highest 的语义是「使用该账户可用的最高令牌」。孩子若是标准用户，
        进程仍然是非提权的 —— 勾了这个选项不会凭空给标准用户一个管理员令牌。
        迭代一的核心能力（计时 + 锁屏）不需要管理员权限，所以可接受；
        但 get-local-users.ps1 在标准用户下有 Access denied 风险，需要在孩子账户上实测。

    为什么还要改几个「README 没提」的设置：
        Task Scheduler 的默认值对常驻守护程序是致命的 ——
          DisallowStartIfOnBatteries / StopIfGoingOnBatteries 默认 true（笔记本不插电直接不启动）
          ExecutionTimeLimit 默认 PT72H（跑满 3 天被强制结束）
        不设就等于「装好了但不会生效」，所以这里显式覆盖。

.PARAMETER TaskName
    任务名称，默认 child-guardian-center。

.PARAMETER SourceExe
    打包产物（单个 .exe）的路径，安装时会被复制到 InstallDir。

.PARAMETER InstallDir
    exe 的固定安装目录，默认 C:\Program Files\child-guardian-center。
    任务指向这里而不是 dist\：dist 下的产物带版本号、且 git clean 会清掉，
    任务里的路径一旦失效，孩子登录后什么都不会发生（而且不报错）。

.PARAMETER User
    指定「只在哪个账户登录时触发」，格式 child 或 .\child 或 机器名\child。
    留空 = 任何用户登录都触发，并以「登录用户本人」的身份运行（用 Users 组 SID 作 principal）。

.PARAMETER Uninstall
    停止并删除任务，同时删除 InstallDir。

.PARAMETER DryRun
    只打印将要注册的任务定义，不改动系统（也不需要管理员权限）。

.EXAMPLE
    powershell -File scripts\setup-task.ps1 -SourceExe dist\child-guardian-center.exe

.EXAMPLE
    powershell -File scripts\setup-task.ps1 -SourceExe dist\child-guardian-center.exe -User child -DryRun
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'child-guardian-center',
    [string] $SourceExe = '',
    [string] $InstallDir = (Join-Path $env:ProgramFiles 'child-guardian-center'),
    [string] $User = '',
    [switch] $Uninstall,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# Users 内置组的知名 SID。用 SID 而不是组名 'Users'：内置组名在非英文系统上会被本地化
# （中文系统是「Users」仍在，但其他语言不一定），SID 全球一致 —— 与 get-local-users.ps1 同一套做法。
$UsersGroupSid = 'S-1-5-32-545'

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Fail {
    param([string] $Message)

    Write-Host "[X] $Message"
    exit 1
}

# 停掉正在运行的任务与残留进程。
# 便携版是「外壳 stub + %TEMP% 解压目录里的真 exe」两层，两个进程同名；
# 不先结束就会占着 InstallDir 里的文件，Copy-Item 报「文件正由另一进程使用」。
function Stop-RunningTask {
    param([string] $Name)

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        try {
            Stop-ScheduledTask -TaskName $Name -ErrorAction Stop
            Write-Host "[i] 已停止正在运行的任务：$Name"
        } catch {
            # 任务存在但没在跑时 Stop-ScheduledTask 会报错，属于正常情况
            Write-Host "[i] 任务当前未在运行：$Name"
        }
    }

    Get-Process -Name $Name -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "[i] 结束残留进程 PID=$($_.Id)"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

# 触发器 / 身份 / 操作 / 设置，四段定义单独抽出来，DryRun 和真实注册共用同一份，避免打印与执行不一致
function New-TaskDefinition {
    param(
        [string] $ExePath,
        [string] $WorkDir,
        [string] $TargetUser,
        [string] $RunLevel
    )

    # 需求：「操作为启动程序，程序或脚本指向生成的 .exe」
    $action = New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory $WorkDir

    if ($TargetUser) {
        # 需求：「只在用户登录时运行」—— 限定到具体账户
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $TargetUser
        # LogonType 必须是 Interactive：任务要在孩子的交互会话里跑，锁屏才锁得到那个会话
        $principal = New-ScheduledTaskPrincipal -UserId $TargetUser -LogonType Interactive -RunLevel $RunLevel
    } else {
        # 任何用户登录都触发
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        # 用 Users 组作 principal = 「谁登录就以谁的身份、在谁的交互会话里运行」，这是能锁对屏幕的关键。
        # 注意：New-ScheduledTaskPrincipal 的 Group 参数集只有 GroupId + RunLevel，
        # 传 -LogonType 会报 AmbiguousParameterSet（LogonType 只属于 User 参数集）；
        # 不传时 cmdlet 会自动落成 LogonType=Group，正是这里要的语义。
        $principal = New-ScheduledTaskPrincipal -GroupId $UsersGroupSid -RunLevel $RunLevel
    }

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable

    @{ Action = $action; Trigger = $trigger; Principal = $principal; Settings = $settings }
}

function Write-DefinitionSummary {
    param([hashtable] $Def)

    Write-Host '  操作     : ' -NoNewline
    Write-Host $Def.Action.Execute
    $triggerKind = $Def.Trigger.CimClass.CimClassName
    if ($User) {
        Write-Host "  触发器   : $triggerKind（仅 $User 登录时）"
    } else {
        Write-Host "  触发器   : $triggerKind（任何用户登录时）"
    }
    $who = if ($Def.Principal.UserId) { $Def.Principal.UserId } else { $Def.Principal.GroupId }
    Write-Host "  身份     : $who  RunLevel=$($Def.Principal.RunLevel)  LogonType=$($Def.Principal.LogonType)"
    Write-Host "  电池     : DisallowStartIfOnBatteries=$($Def.Settings.DisallowStartIfOnBatteries) StopIfGoingOnBatteries=$($Def.Settings.StopIfGoingOnBatteries)"
    Write-Host "  时长上限 : $($Def.Settings.ExecutionTimeLimit)（PT0S = 不限制）"
}


# ============================== 卸载分支 ==============================
if ($Uninstall) {
    Write-Host "[i] 卸载计划任务：$TaskName"
    Stop-RunningTask -Name $TaskName

    if ($DryRun) {
        Write-Host '[i] DryRun：以上为预演，未删除任务，也未删除安装目录'
        exit 0
    }

    if (-not (Test-Admin)) {
        Fail '删除计划任务需要管理员权限，请用「以管理员身份运行」的终端重试'
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $InstallDir) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
        Write-Host "[i] 已删除安装目录：$InstallDir"
    }
    Write-Host "[OK] 已卸载任务 $TaskName"
    exit 0
}

# ============================== 安装分支 ==============================
if (-not $SourceExe) {
    Fail '-SourceExe 不能为空：请指向打包产物，例如 dist\child-guardian-center.exe'
}
if (-not (Test-Path -LiteralPath $SourceExe)) {
    Fail "找不到打包产物：$SourceExe（先执行 npm run build:portable）"
}

$SourceExe = (Resolve-Path -LiteralPath $SourceExe).Path
$exeName = Split-Path -Path $SourceExe -Leaf
$targetExe = Join-Path -Path $InstallDir -ChildPath $exeName

if ($User) {
    # 只警告不阻断：域账户 / 拼写差异在这里判不出来，真正的失败会在 Register-ScheduledTask 报
    $bareName = $User -replace '^.*\\', ''
    if (-not (Get-LocalUser -Name $bareName -ErrorAction SilentlyContinue)) {
        Write-Host "[!] 本机没有名为 '$bareName' 的本地账户（域账户可忽略此警告）"
    }
}

$definition = New-TaskDefinition -ExePath $targetExe -WorkDir $InstallDir -TargetUser $User -RunLevel 'Highest'

Write-Host ''
Write-Host "[i] 将要注册的计划任务：$TaskName"
Write-DefinitionSummary -Def $definition

if ($DryRun) {
    Write-Host ''
    Write-Host "[i] DryRun：未复制文件（$SourceExe -> $targetExe），未注册任务"
    exit 0
}

# 注册任务 / 写 Program Files 都需要管理员权限。install-app.mjs 会先自检并自动弹 UAC 提权，
# 这里再挡一道是为了手工执行本脚本时能给出可读的报错，而不是抛一串 COM 异常。
if (-not (Test-Admin)) {
    Fail '注册计划任务需要管理员权限，请用「以管理员身份运行」的终端重试（或走 npm run install:app 自动提权）'
}

Stop-RunningTask -Name $TaskName

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -LiteralPath $SourceExe -Destination $targetExe -Force
Write-Host "[i] 已复制产物：$targetExe"

$description = '孩童电脑使用时长管控：登录时自启动，超时锁屏并强制休息。由 npm run install:app 注册。'

try {
    Register-ScheduledTask -TaskName $TaskName -Action $definition.Action -Trigger $definition.Trigger `
        -Principal $definition.Principal -Settings $definition.Settings -Description $description -Force | Out-Null
} catch {
    # 「组 SID + RunLevel Highest」在个别策略环境（本地安全策略 / 域 GPO 限制）下会被拒，
    # 降级成 Limited 让任务至少能跑起来 —— 迭代一的计时与锁屏都不需要管理员权限。
    Write-Host "[!] 以 RunLevel=Highest 注册失败：$($_.Exception.Message)"
    Write-Host '[i] 降级为 RunLevel=Limited 重试'
    $definition = New-TaskDefinition -ExePath $targetExe -WorkDir $InstallDir -TargetUser $User -RunLevel 'Limited'
    Register-ScheduledTask -TaskName $TaskName -Action $definition.Action -Trigger $definition.Trigger `
        -Principal $definition.Principal -Settings $definition.Settings -Description $description -Force | Out-Null
}

# 回读一遍确认落库结果，别只信 Register-ScheduledTask 没抛异常
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ''
Write-Host "[OK] 计划任务已注册：$TaskName"
Write-Host "  任务路径 : $($task.TaskPath)$TaskName"
Write-Host "  状态     : $($task.State)"
Write-Host "  操作     : $($task.Actions[0].Execute)"
Write-Host "  工作目录 : $($task.Actions[0].WorkingDirectory)"
Write-Host ''
Write-Host "  立即验证 : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  查看日志 : Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "  卸载     : npm run uninstall:app"
exit 0
