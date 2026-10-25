import { useRef } from 'react'
import type { FocusEvent } from 'react'

/**
 * 输入框的聚焦 / 失焦事件类型。
 *
 * 用 React 的合成事件（`FocusEvent<HTMLInputElement>`）而不是 DOM 原生的 `FocusEvent`：
 * 只有前者才能直接接给 JSX 的 onFocus / onBlur，否则 `onFocus={focusEvt}` 会报类型不兼容
 * （React.FocusEvent 不是原生 FocusEvent 的子类型）。
 */
type InputFocusEvent = FocusEvent<HTMLInputElement>

/** useCheckInputChange 的入参：两个回调都可选，调用方按需传 */
export interface CheckInputChangeHandlers {
  /** 聚焦时触发（调用前已经把当前值记进缓存） */
  focusHandler?: (e: InputFocusEvent) => void
  /** 失焦时触发，且**只在值相对聚焦那一刻真的变了**才触发 */
  blurHandler?: (e: InputFocusEvent) => void
}

/** useCheckInputChange 的返回值：直接摊到 input 的 onFocus / onBlur 上 */
export interface CheckInputChangeResult {
  focusEvt: (e: InputFocusEvent) => void
  blurEvt: (e: InputFocusEvent) => void
}

/**
 * 「值没变就不算一次编辑」的 hook：聚焦时记下当前值，失焦时只有值真的变了才回调 blurHandler。
 *
 * 用途是挡住无意义的落库 —— App.tsx 的 blurHandler 会写 electron-store 并重新拉一次列表，
 * 用户只是点进输入框又点出来（一个字没改）时，没必要付这个代价。
 */
export const useCheckInputChange = ({
  focusHandler,
  blurHandler
}: CheckInputChangeHandlers): CheckInputChangeResult => {
  /**
   * 聚焦那一刻的输入值。
   *
   * 必须用 useRef，不能写 `const cache = { value: '' }`：普通对象**每次渲染都会重建**，
   * 而输入框的 onChange 通常就会 setState 触发重渲染（App.tsx 的 change() 正是如此），
   * 于是 focus 时记下的值在下一次渲染立刻被重置成空串，blur 时 `value !== ''` 恒为 true，
   * 「值没变就不落库」的判断彻底失效。useRef 的值跨渲染保持稳定。
   */
  const cacheRef = useRef('')

  const focusEvt = (e: InputFocusEvent): void => {
    console.log('focusEvt e: ', e)
    cacheRef.current = (e.target as HTMLInputElement).value
    focusHandler?.(e)
  }

  const blurEvt = (e: InputFocusEvent): void => {
    const { value } = e.target as HTMLInputElement
    if (!Object.is(value, cacheRef.current)) {
      blurHandler?.(e)
    }
  }

  return { focusEvt, blurEvt }
}
