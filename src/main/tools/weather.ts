// weather.query 工具：Open-Meteo 免费天气 API（无需 Key、无需注册）
// 地理编码：https://geocoding-api.open-meteo.com/v1/search（支持中英文城市名）
// 天气数据：https://api.open-meteo.com/v1/forecast（WMO weather_code → 中文描述）
// 全部出网走 safeFetch（SSRF 防护 + 超时 + 字节上限）。
import type { BuiltinTool } from './builtin'
import { safeFetch } from '../net/safe-fetch'

/** WMO weather interpretation codes（官方码表 → 中文描述） */
const WMO_CODES: Record<number, string> = {
  0: '晴',
  1: '基本晴',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇（冻结雾）',
  51: '小毛毛雨',
  53: '中毛毛雨',
  55: '大毛毛雨',
  56: '轻冻毛毛雨',
  57: '重冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '小冻雨',
  67: '大冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹'
}

function describeCode(code: number | undefined): string {
  if (typeof code !== 'number') return '未知'
  return WMO_CODES[code] ?? `未知天气码(${code})`
}

interface GeocodeHit {
  name: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
}

async function geocode(location: string, signal?: AbortSignal): Promise<GeocodeHit> {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(location) +
    '&count=1&language=zh&format=json'
  const res = await safeFetch(url, { signal, timeoutMs: 10_000, maxBytes: 512 * 1024 })
  if (res.status !== 200) throw new Error(`地理编码服务返回 HTTP ${res.status}`)
  let data: { results?: GeocodeHit[] }
  try {
    data = JSON.parse(res.body.toString('utf8')) as { results?: GeocodeHit[] }
  } catch {
    throw new Error('地理编码服务返回了无效的 JSON 响应')
  }
  const hit = data.results?.[0]
  if (!hit) throw new Error(`未找到地点「${location}」，请尝试更大的城市名`)
  return hit
}

export const weatherTool: BuiltinTool = {
  schema: {
    id: 'weather.query',
    name: 'weather_query',
    description:
      '查询指定城市的实时天气与未来预报（含温度/体感/湿度/风速/降水与天气现象）。免费公共服务，无需配置。参数：location (string，城市名，中英文均可)，days (number, 可选, 预报天数 1-3, 默认 1=仅当天)。',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市名，如 北京 / Shanghai' },
        days: { type: 'number', description: '预报天数 1-3，默认 1' }
      },
      required: ['location'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args, ctx) {
    const location = String(args?.location ?? '').trim()
    if (!location) throw new Error('location 不能为空')
    const days = Math.min(3, Math.max(1, Math.floor(Number(args?.days) || 1)))

    const hit = await geocode(location, ctx?.signal)
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum' +
      `&timezone=auto&forecast_days=${days}`
    const res = await safeFetch(url, { signal: ctx?.signal, timeoutMs: 10_000, maxBytes: 512 * 1024 })
    if (res.status !== 200) throw new Error(`天气服务返回 HTTP ${res.status}`)
    let data: {
      current?: Record<string, number>
      daily?: {
        time: string[]
        weather_code: number[]
        temperature_2m_max: number[]
        temperature_2m_min: number[]
        precipitation_sum: number[]
      }
    }
    try {
      data = JSON.parse(res.body.toString('utf8')) as typeof data
    } catch {
      throw new Error('天气服务返回了无效的 JSON 响应')
    }

    const c = data.current
    const daily = (data.daily?.time ?? []).map((date, i) => ({
      date,
      weather: describeCode(data.daily?.weather_code?.[i]),
      maxTemp: data.daily?.temperature_2m_max?.[i],
      minTemp: data.daily?.temperature_2m_min?.[i],
      precipMm: data.daily?.precipitation_sum?.[i]
    }))

    return JSON.stringify({
      location: { name: hit.name, admin1: hit.admin1 ?? null, country: hit.country ?? null },
      current: c
        ? {
            temperature: c.temperature_2m,
            feelsLike: c.apparent_temperature,
            humidity: c.relative_humidity_2m,
            windSpeed: c.wind_speed_10m,
            precipMm: c.precipitation,
            weather: describeCode(c.weather_code)
          }
        : null,
      daily,
      unit: '°C'
    })
  }
}
