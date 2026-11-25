// OAuth 授权提示不能无条件承诺“凭据加密存储”：
// none 模式下主进程会拒存 OAuth token/secret，四语文案必须把这条边界说清楚。
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ko } from '../src/renderer/src/i18n/ko'
import { ja } from '../src/renderer/src/i18n/ja'

const hints = {
  zh: zh['agent.oauthHint'],
  en: en['agent.oauthHint'],
  ko: ko['agent.oauthHint'],
  ja: ja['agent.oauthHint']
}

describe('OAuth 提示的四语 none 模式边界', () => {
  it('四语都存在 oauthHint，且不再无条件声称凭据已加密', () => {
    for (const [lang, hint] of Object.entries(hints)) {
      expect(hint, lang).toBeTruthy()
      expect(hint, lang).not.toContain('凭据加密保存在本机；Token')
      expect(hint, lang).not.toContain('Credentials are encrypted locally; tokens')
      expect(hint, lang).not.toContain('자격 증명은 암호화되어 저장되며 토큰은')
      expect(hint, lang).not.toContain('資格情報は暗号化して保存され、トークンは')
    }
  })

  it('中文/英文明确区分已设主密码与未设主密码', () => {
    expect(hints.zh).toContain('设置主密码后')
    expect(hints.zh).toContain('未设主密码时不会保存 OAuth Token')
    expect(hints.en).toContain('master password set')
    expect(hints.en).toContain('without one, OAuth tokens are not saved')
  })

  it('韩文/日文明确区分已设主密码与未设主密码', () => {
    expect(hints.ko).toContain('마스터 비밀번호를 설정하면')
    expect(hints.ko).toContain('설정하지 않으면 OAuth Token을 저장하지 않습니다')
    expect(hints.ja).toContain('マスターパスワードを設定すると')
    expect(hints.ja).toContain('未設定の場合は OAuth トークンを保存しません')
  })

  it('四语都保留“Token 不进 UI/日志”的承诺', () => {
    expect(hints.zh).toContain('Token 不会显示在界面，也不会写进日志')
    expect(hints.en).toContain('never shown in the UI or written to logs')
    expect(hints.ko).toContain('Token은 화면이나 로그에 표시되지 않습니다')
    expect(hints.ja).toContain('トークンは画面にもログにも出しません')
  })
})
