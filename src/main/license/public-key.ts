// 内置 RSA 公钥（DER 格式 Base64 编码）——历史许可证（v1 签名，无算法前缀）验签用。
// 由 scripts/generate-license-key.js 生成，与私钥配对
// 私钥仅在发行侧保存，绝不能嵌入应用
export const PUBLIC_KEY_DER_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsx9H6w9K/Xt8ztBdWUC4ZVV6qYQTRVVS85SvT5FUMAaONfEau5uHn64+LhfFOegtccCPK/G9IDwprRbDGX05Ynahu7x2LH/RU9YcRPKI1Qxl9wT1Da6HvCJA+klcTZ2bNDtnmBdge0mPtsNmCLxlKppIYqcAx0THc8ItD03mVIzy1KKYuJGR1QvKhJAy2wUCshznmGO/aYvOyloQ1zHSa8fV95prj0fpE71ELBx0tuJVplLjCcQYjqY409KbQOKdSBZZ0iLr4ptCrzHWZuFYdjWyyDQP2kW2PkTrBWRI/YNAtborC9e6JB+mGtx6GWQAGqFUTPjRR6FWe4jSoD5lkQIDAQAB'

/**
 * Ed25519 公钥（SPKI DER 的 Base64，即 `-----BEGIN PUBLIC KEY-----` 之间的内容）。
 *
 * SEC-16-15 密钥版本分流：新证签名字段带 `ed25519:` 前缀，只走这把公钥验签；
 * 历史 RSA 证（裸 base64 签名）继续走上面的 PUBLIC_KEY_DER_B64，互不影响。
 *
 * ⚠️ 当前为空串 = 尚未完成 SEC-16-02 的密钥轮换：所有 ed25519: 新证一律 fail-closed。
 * 运维动作（代码侧无法代劳）：离线生成 Ed25519 密钥对 → 私钥交 CI Secret / HSM /
 * 离线签名机保管（绝不能落进仓库或交付工作区）→ 把公钥 SPKI DER Base64 填入本常量
 * → 与本版本客户端同批发布。填错/填错格式时 createPublicKey 抛错，验签同样 fail-closed。
 */
export const ED25519_PUBLIC_KEY_B64 = ''
