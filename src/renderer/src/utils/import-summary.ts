// 外部导入（ChatGPT / Claude 记录）这一格的两句实话（V4-Iter-370）
//
// 为什么要有这一份：这两处文本过去都是**主进程里的手抄中文**（`conversation-import-external.ts` 的
// `warnings.push('…')` 与 handler 的 `` `${file.name}: …` ``），而 `ChatModule.tsx` 把数组原样
// `toast.error(…join('\n'))` ⇒ 英／日／韩界面在这一格读到中文（同 §156 模型推荐那一屏的口径）。
// 另一半是数：屏上那句「导入 m 条消息」只算**收下的**，文件里被逐条跳过的行哪儿都没说
// ⇒「导入 800 条」可以比真实消息少几十条而屏上一句没有。
//
// 码写成字面量联合、登记表写成 `Record<码联合, string>`：加一个码不登记就直接编译不过，
// 不靠"下一次界面上出现裸码才发现"（§243 真撞过一次：`SNAPSHOT_DIVERGED` 被原样弹给用户）。
import type {
  ExternalDroppedMessages,
  ExternalWarning,
  ExternalWarningCode
} from '../../../shared/conversation-import-external'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** 导入告警的回码 → 四语 key 的**唯一**登记表（新增码必须同时在这里登记，闸门会双向对账） */
export const IMPORT_WARNING_KEYS: Record<ExternalWarningCode, string> = {
  IMPORT_FILE_NOT_JSON: 'chat.importExternalWarnFileNotJson',
  IMPORT_NOT_ARRAY: 'chat.importExternalWarnNotArray',
  IMPORT_CONV_LIMIT: 'chat.importExternalWarnConvLimit',
  IMPORT_MSG_LIMIT: 'chat.importExternalWarnMsgLimit',
  IMPORT_UNKNOWN_FORMAT: 'chat.importExternalWarnUnknownFormat',
  IMPORT_WRITE_FAILED: 'chat.importExternalWarnWriteFailed'
}

/**
 * 一条告警渲染成一句本地话。`where`（文件名／会话名）是用户数据、不进字典，
 * 由 `chat.importExternalWarnWhere` 这个"带出处的句式"拼上去——zh／ja 用「：」、en／ko 用 ": "，
 * 所以间隔符本身也在字典里，不在这里硬写。
 * 认不出的码（旧版主进程发来的）回落成通用那句，**绝不把裸码贴到屏上**。
 */
export function importWarningText(w: ExternalWarning, t: Translate): string {
  const key = (IMPORT_WARNING_KEYS as Record<string, string | undefined>)[w.code]
  const sentence = key ? t(key, w.args) : t('chat.importExternalWarnUnknown')
  return w.where ? t('chat.importExternalWarnWhere', { where: w.where, text: sentence }) : sentence
}

/** 四类丢弃的固定顺序（明细里只列非零的那几类；顺序定了四语的读法才一致） */
const DROP_KINDS: ReadonlyArray<readonly [keyof ExternalDroppedMessages, string]> = [
  ['badJson', 'chat.importExternalDropBadJson'],
  ['notEvent', 'chat.importExternalDropNotEvent'],
  ['nonText', 'chat.importExternalDropNonText'],
  ['emptyText', 'chat.importExternalDropEmptyText']
]

/**
 * 「另有 N 条内容没被当成消息读入（分类明细）」；一条都没丢就返回 null（不许画一句"0 条"）。
 * `dropped` 缺失＝对端是没这个字段的老主进程，此时**一句都不说**：把"没有这个数"演成"确实没丢东西"
 * 是 §343／第 36 条那一族的谎报形状。
 */
export function importDroppedText(dropped: ExternalDroppedMessages | undefined, t: Translate): string | null {
  if (!dropped) return null
  const parts = DROP_KINDS
    .map(([field, key]) => ((dropped[field] ?? 0) > 0 ? t(key, { n: dropped[field] }) : null))
    .filter((s): s is string => s !== null)
  if (parts.length === 0) return null
  const total = DROP_KINDS.reduce((sum, [field]) => sum + (dropped[field] ?? 0), 0)
  return t('chat.importExternalDropped', { n: total, kinds: parts.join(t('chat.importExternalDropSep')) })
}
