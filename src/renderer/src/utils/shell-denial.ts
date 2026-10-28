// §339：被安全策略硬拒的那句 shell 结果，屏上按当前界面语言取译文
//
// 主进程写进 tool 结果 content 的是「中文句子＋回码」（`命令被安全策略拒绝：BLOCKED_ROOT_DELETE`
// 与执行闸门那发的 `命令被安全策略拒绝（BLOCKED_FORMAT）`），那份原文同时要喂给模型，不能改。
// 四语字典里 `agent.approval.reason.*` 那十条早就写好了（审批对话框在读），缺的是这条屏上的消费点
// ⇒ 这里只做「认出结尾那个码 ⇒ 查字典替换整句」，认不出（未知码／句子改过味）就原样显示，宁可裸码不丢信息。
// 主进程那两句的字面由 gates 测试钉住，改味会红而不是悄悄失效。

const DENIAL = /^命令被安全策略拒绝[:：(（]\s*([A-Z][A-Z0-9_]*)\s*[)）]?$/

export function localizeShellDenial(content: string, t: (key: string) => string): string {
  const m = DENIAL.exec(content)
  if (!m) return content
  const key = `agent.approval.reason.${m[1]}`
  const text = t(key)
  return text === key ? content : text
}
