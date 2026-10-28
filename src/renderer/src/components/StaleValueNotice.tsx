// 「这一屏的数据没能刷新成最新，下面画的是上一次读到的值」那句（V4-Iter-345）。
//
// 为什么不能复用 §222 的 LoadFailNotice：那一块是**整块替代**——没读到就没有内容可显示，
// 所以本体换成那句原因；§226 的 ShowingDefaultsNotice 说的是"有东西，但那是初始字面量、不是你的设置"。
// 这一族是第三种谎报：**面板先读到过值，之后又重读了几发**（轮询／切时间窗／重新扫描／锁屏事件／
// 面板动作后刷新），重读失败时旧值留着是对的一半（清掉反而把已读到的东西丢了），
// 但屏上从此再说不出"这一发没成"——门写在 `if (!数据)` 那条路上，数据在，门就不开。
// 于是用户拿一份没人认领的旧数据当现状：设置页据此去动一个已经变明文的库、
// 用量页把 7 天窗的数字读成 30 天窗、管家页照着旧推荐去装模型。
//
// 口径与 §222／§226 一致：① `role="alert"`（toast 是 `role="status"`，混在一个读数里就分不开）；
// ② 提示带 `{what}` 点名是哪一格（一块面板里可能只有部分数据来自失败那一发，§257 逐发点名）；
// ③ 与那两块不同，这里**给得起「重试」**——这几发读本来就有一条现成的重读路径，
//   按钮直接接那一发的调用方（§268 的教训：按钮不许放进 role="alert" 容器里，
//   否则 textContent 会把「重试」两个字算进句子，用例读到的就不是那句话了）。
//
// 句子取自 §230 已有的 `common.refreshFailed`（知识库文档列表那批就先这么写的"刷新失败＋界面停在上一份"），
// 这里只按 `loadFailed`→`loadFailedNamed` 的既有做法加一个 `{what}` 成对键，不另立新话术。
import React from 'react'
import { useI18n } from '../i18n'

export const StaleValueNotice: React.FC<{
  /** 屏上已有的标题名词，点名是哪一格没刷新（不复用整块标题的 emoji 前缀） */
  what: string
  msg: string
  onRetry: () => void
  testid: string
}> = ({ what, msg, onRetry, testid }) => {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {/* 只借 §230 那句话，不借 LoadFailNotice 的「读不到」——那一块说的是一发都没读到 */}
      <div
        role="alert"
        className="text-xs px-3 py-2 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] leading-relaxed"
      >
        {t('common.refreshFailedNamed', { what, msg })}
      </div>
      <button data-testid={testid} className="text-xs underline text-[var(--color-text-muted)]" onClick={onRetry}>
        {t('agent.retryRead')}
      </button>
    </div>
  )
}
