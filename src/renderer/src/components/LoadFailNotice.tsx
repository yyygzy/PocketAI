// 「读不到」那句：与「加载中…」相对的另一半（V4-Iter-222）。
//
// 为什么要有这个组件：safeHandle 的失败是 resolve 的 `{ok:false}`（§196），§221 把「失败对象被当数据写进 state」
// 那一族收口后，读失败的面板改成"保持上一次的值"——首次挂载没有上一次的值，于是本体停在 `if (!x) return 加载中…`，
// **把"这次没读到"谎称成"还在加载"**。这里把那句话补成界面事实：原因常驻，不是一条会消失的 toast。
//
// 口径两条：① 文案只陈述"读不到"，不写"请重试"——恢复路径各面板不一样（Ollama 有 8s 轮询、设置页靠重进），
// 统一承诺一句没走过的路就是假话（同 §154 那条纪律）；② `role="alert"` 而不是 `role="status"`：
// toast 面板用的是 status，两者混在同一个读数里，用例就分不开"弹过一条"与"界面此刻仍读不到"。
import React from 'react'
import { useI18n } from '../i18n'

export const LoadFailNotice: React.FC<{ msg: string }> = ({ msg }) => {
  const { t } = useI18n()
  return (
    <div
      role="alert"
      className="text-xs px-3 py-2 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] leading-relaxed"
    >
      {t('common.loadFailed', { msg })}
    </div>
  )
}
