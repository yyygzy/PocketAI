// 生成 RSA 密钥对，用于 License 离线验签
// 使用方式: node scripts\generate-license-key.js
// 公钥填入 src/main/license/public-key.ts，私钥只在发行侧保存
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })

fs.writeFileSync(path.join(outDir, 'license-private.pem'), privateKey, 'utf8')
fs.writeFileSync(path.join(outDir, 'license-public.pem'), publicKey, 'utf8')

// 提取 PEM 中的 DER 内容，方便嵌入代码
const derB64 = publicKey
  .replace('-----BEGIN PUBLIC KEY-----', '')
  .replace('-----END PUBLIC KEY-----', '')
  .replace(/\s/g, '')

console.log('密钥对已生成:')
console.log('  build/license-private.pem  ← 私钥，发行侧保管')
console.log('  build/license-public.pem   ← 公钥，嵌入应用')
console.log()
console.log('公钥 DER Base64（填入 src/main/license/public-key.ts）:')
console.log(`export const PUBLIC_KEY_DER_B64 = '${derB64}'`)
