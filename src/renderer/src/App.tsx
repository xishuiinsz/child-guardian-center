import { useEffect, useState } from 'react'
import electronLogo from './assets/electron.svg'
// 只做类型引用，构建时会被完全擦除（tsconfig 开了 isolatedModules，必须写 import type）
import type { UserInfo } from '@preload/ipc'
import { durationConfigInit } from '@utils/const'

/**
 * `<input type="number">` 的 onChange 里 `e.target.value` 永远是字符串，
 * 而 UserInfo 里两个时长字段都声明成 number，直接塞回 state 就是类型漏洞
 * （原来 change 的入参是隐式 any，谁都没拦住），最后原样发给主进程。
 * 统一在这里转成非负整数；输入框被清空 / 输入非法值时按 0 处理，
 * 与主进程 `store.set(..., parseInt(...))` 存的数字保持一致。
 */
const toMinutes = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 一次列表拉取的结果：失败也归一化成返回值，由调用方决定要不要写进 state */
type UserListResult = { ok: true; list: UserInfo[] } | { ok: false; message: string }

/**
 * 拉一次用户列表。
 *
 * 这是**纯 IPC 调用**：不碰任何 state、失败也不抛（错误归一化成 `{ ok: false, message }`）。
 * 放在模块作用域是因为它不依赖组件里的任何值 —— 既不用每次渲染重建，
 * 也让「首屏加载（effect）」和「失焦后重新拉取（事件处理器）」共用同一份实现。
 *
 * 为什么不用 `window.electron.ipcRenderer.send('user:list')`：send 是单向通信，
 * 在渲染进程里同步返回 undefined，主进程 ipcMain.on 回调里的 return 也会被 Electron 丢掉，
 * 所以永远拿不到数据。这里走 preload 暴露的 window.api.getUserList()
 * （内部是 ipcRenderer.invoke ↔ 主进程 ipcMain.handle），await 到的就是主进程的返回值。
 */
const loadUserList = async (): Promise<UserListResult> => {
  try {
    const list = await window.api.getUserList()
    console.log('loadUserList userList: ', list)
    return { ok: true, list }
  } catch (err) {
    // 主进程 handler 里 throw 的错误会顺着 invoke 变成 rejection 抛到这里
    const message = err instanceof Error ? err.message : String(err)
    console.error('loadUserList failed: ', message)
    return { ok: false, message }
  }
}

function App(): React.JSX.Element {
  const [userList, setUserList] = useState<UserInfo[]>([])
  /**
   * 初值直接是 true：组件一挂载就在拉列表。
   * 若改成在 effect 里 `setLoading(true)`，就是「挂载 → effect 同步 setState → 再渲染一次」
   * 的级联渲染（react-hooks/set-state-in-effect 拦的正是这个），首屏还会闪一下「获取系统用户信息」。
   */
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editable, setEditable] = useState(false)

  /**
   * 把一次拉取的结果写进 state。
   *
   * 注意它**不含** `setLoading(true)`：调用方都是在 `await` 之后才触发这些 setState，
   * 因此 effect 的同步阶段一次 setState 都不会执行。
   * 失败时清空列表，避免界面继续显示上一次的旧数据、却看不出错在哪。
   */
  const applyUserListResult = (result: UserListResult): void => {
    if (result.ok) {
      setUserList(result.list)
      setError('')
    } else {
      setError(result.message)
      setUserList([])
    }
    setLoading(false)
  }

  /**
   * 输入过程中只改内存里的这一行，落库留给 onBlur —— 否则每敲一个键就写一次 electron-store。
   * 入参必须是 UserInfo：这样 `allowedDuration: e.target.value`（字符串）这类写法会当场编译报错，
   * 而不是像原来的隐式 any 一样静默通过。
   */
  const change = (data: UserInfo): void => {
    setUserList((prev) => {
      return prev.map((prevUser) => {
        // 用 id（SID 末段 RID）匹配：它是稳定唯一键，name 在同名账户 / 排序变化时不可靠
        if (prevUser.id === data.id) {
          return { ...prevUser, ...data }
        }
        return prevUser
      })
    })
  }

  const blurHandler = async (data: UserInfo): Promise<void> => {
    try {
      await window.api.setUerData(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('setUerData failed: ', message)
      setError(message)
      return
    }

    setLoading(true)
    setError('')
    applyUserListResult(await loadUserList())
  }

  const fetchUserList = (): void => {
    const load = async (): Promise<void> => {
      setLoading(true)
      const result = await loadUserList()
      applyUserListResult(result)
    }

    void load().finally(async () => {
      setLoading(false)
    })
  }

  useEffect(fetchUserList, [])

  return (
    <>
      <img alt="logo" className="logo" src={electronLogo} />

      <div className="actions">
        <div className="action">
          <a target="_blank" rel="noreferrer" onClick={fetchUserList}>
            {loading ? '更新中...' : '更新用户列表'}
          </a>
        </div>
        <div className="action">
          <a target="_blank" rel="noreferrer">
            编辑
          </a>
        </div>
      </div>

      {error ? <p className="user-error">{error}</p> : null}
      {userList.length > 0 ? (
        <ul className="user-list flex-direction-column">
          {userList.map((user) => (
            <li key={user.id || user.name} className="user-item">
              <div className="content-item h24">
                <span className="user-id">用户</span>
                <span>{user.name}</span>
              </div>

              <div className="content-item h24 flex-x-center">
                <span>启用</span>
                <input className="ml8" type="checkbox" />
              </div>

              <div className="content-item h24">
                <span>单次可用时长(分钟)</span>
                {editable ? (
                  <input
                    className="ml8 w80"
                    type="number"
                    min={0}
                    name="allowedDuration"
                    value={user.allowedDuration ?? durationConfigInit.allowedDuration}
                    onChange={(e) =>
                      change({ ...user, allowedDuration: toMinutes(e.target.value) })
                    }
                    onBlur={() => void blurHandler({ ...user })}
                  />
                ) : (
                  <span className="ml8">
                    {user.allowedDuration ?? durationConfigInit.allowedDuration}
                  </span>
                )}
              </div>
              {/* 结构与上面那块保持完全一致：label 和 input 平铺在 content-item 里。
                  原来外层多包了一个没有样式作用的 <span>，只会让两行输入框的对齐 / 间距不一致；
                  顺手去掉 label 上的空 className=""（React 会照样渲染出 class=""）。 */}
              <div className="content-item h24">
                <span>单次最少休息(倍数)</span>
                {editable ? (
                  <input
                    className="ml8 w80"
                    type="number"
                    min={1}
                    name="disabledTimes"
                    value={user.disabledTimes ?? durationConfigInit.disabledTimes}
                    onChange={(e) => change({ ...user, disabledTimes: toMinutes(e.target.value) })}
                    onBlur={() => void blurHandler({ ...user })}
                  />
                ) : (
                  <span className="ml8">
                    {user.disabledTimes ?? durationConfigInit.disabledTimes}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

export default App
