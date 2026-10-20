// 「读不到，但这里显示的是默认值」那句（V4-Iter-226）。
//
// 为什么不复用 §222 的 `LoadFailNotice`：那一块是**整块替代**——没读到就没有内容可显示，所以本体换成那句原因。
// 这一族不一样：面板的门在失败时**照样解除**（`setLoaded(true)`），屏上摆着滑块、开关与输入框，
// 值来自各组件的初始字面量。那些字面量确实就是应用的默认值（逐条对过定义，见台账 §226），
// 所以这里能说的不是"没东西"，而是**"有东西，但那不是你的设置"**——两种谎报要两句不同的话。
//
// 口径与 §222 一致：① `role="alert"`（toast 用的是 `role="status"`，混在一个读数里就分不开
// "刚才弹过一条"与"界面此刻仍读不到"）；② 只陈述"读不到＋这是默认值"，**不写"请重试"**——
// 这几发读只在挂载时跑一次，没有重试路径可承诺；③ 提示要带 `{what}`，因为一个面板里可能只有**一部分**
// 数据来自失败的那一发（外观页三条读彼此独立），不点名就会把成功读到的那几项也一起说成默认值。
import React from 'react'
import { useI18n } from '../i18n'

export const ShowingDefaultsNotice: React.FC<{ what: string; msg: string }> = ({ what, msg }) => {
  const { t } = useI18n()
  return (
    <div
      role="alert"
      className="text-xs px-3 py-2 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] leading-relaxed"
    >
      {t('common.loadFailedDefaults', { what, msg })}
    </div>
  )
}
