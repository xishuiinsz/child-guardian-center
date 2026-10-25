/**
 * `powershell`(npm v2.3.3) 包内没有任何 .d.ts，本包 tsconfig 开了 strict，
 * 直接 import 会报 TS7016（隐式 any）。这里按 lib/index.js 的真实实现补一份最小声明。
 *
 * 事件语义（对应 lib/index.js）：
 * - 'output'       子进程 close 时触发一次，参数是 stdout 全量字符串（**不是流式**）
 * - 'error-output' stderr 数据，可能触发多次（脚本报错、找不到文件都在这里）
 * - 'error'        spawn 失败，例如 powershell.exe 不在 PATH
 * - 'end'          在 'output' 之后触发，参数是进程退出码
 */
declare module 'powershell' {
  import { ChildProcess } from 'node:child_process'
  import { EventEmitter } from 'node:events'

  /** -ExecutionPolicy 的合法取值 */
  type ExecutionPolicy =
    'Restricted' | 'AllSigned' | 'RemoteSigned' | 'Unrestricted' | 'Bypass' | 'Undefined'

  interface PowerShellOptions {
    /** 打印子进程启动/退出的调试日志，默认 false */
    debug?: boolean
    /** 是否附加 -NoProfile，默认 true */
    noprofile?: boolean
    /** 附加 -ExecutionPolicy <值>；不传则沿用系统策略（可能是 Restricted） */
    executionpolicy?: ExecutionPolicy
    /** true 用 PowerShell Core 的 pwsh，默认 false（Windows PowerShell 5.1） */
    PSCore?: boolean
  }

  /** 传给 spawno 的回调：进程结束后收到聚合的 stdout/stderr */
  type PowerShellCallback = (err: Error | null, stdout: string, stderr: string) => void

  class PowerShell extends EventEmitter {
    /** 底层 child_process 句柄，需要 kill / 拿 pid 时用 */
    proc: ChildProcess
    /**
     * @param input 命令或脚本，会被拼成 `-Command "& {<input>}"`。
     *   执行 .ps1 文件时必须传**绝对路径**并写成 `& '<path>'`：
     *   相对路径按 process.cwd() 解析（不是按调用方文件位置），裸路径遇到空格会解析失败。
     */
    constructor(input: string, opt?: PowerShellOptions, cb?: PowerShellCallback)
  }

  export = PowerShell
}
