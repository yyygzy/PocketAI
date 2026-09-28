// weather.query 工具 execute 全分支测试
//
// 覆盖 src/main/tools/weather.ts 的 weatherTool.execute：
//  - location 校验：空串抛错
//  - days clamp：<1 → 1、>3 → 3、1-3 → 原值、非数字 → 1
//  - geocode 分支：非 200 抛错、无效 JSON 抛错、results 空抛错
//  - forecast 分支：非 200 抛错、无效 JSON 抛错
//  - 正常流程：geocode 返回 hit + forecast 返回 current + daily → 输出结构
//  - current 缺失 → current: null
//  - daily 缺失 → daily: []
//  - describeCode：WMO 已知码（0=晴/45=雾/95=雷阵雨）、未知码、非数字
//
// 策略：mock safeFetch 按 url 分派 geocode（geocoding-api.open-meteo.com）
//       与 forecast（api.open-meteo.com），返回可控 status/body Buffer。
//       describeCode 与 geocode 未 export，通过 weatherTool.execute 间接覆盖。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: vi.fn()
}))

import { weatherTool } from '../src/main/tools/weather'
import { safeFetch } from '../src/main/net/safe-fetch'

const mockSafeFetch = vi.mocked(safeFetch)

function mockGeocode(hit: { name: string; latitude: number; longitude: number; country?: string; admin1?: string } | null, status = 200): void {
  mockSafeFetch.mockImplementationOnce(async (url: string) => {
    if (String(url).includes('geocoding-api.open-meteo.com')) {
      const body = hit ? JSON.stringify({ results: [hit] }) : JSON.stringify({ results: [] })
      return { status, body: Buffer.from(body, 'utf8') } as any
    }
    throw new Error('unexpected geocode call')
  })
}

function mockForecast(data: unknown, status = 200): void {
  mockSafeFetch.mockImplementationOnce(async (url: string) => {
    if (String(url).includes('api.open-meteo.com')) {
      return { status, body: Buffer.from(JSON.stringify(data), 'utf8') } as any
    }
    throw new Error('unexpected forecast call')
  })
}

function mockGeocodeRaw(body: string, status = 200): void {
  mockSafeFetch.mockImplementationOnce(async () => ({ status, body: Buffer.from(body, 'utf8') } as any))
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── location 校验 ───────────────────────────────────────

describe('weatherTool.execute location 校验', () => {
  it('空 location → 抛 location 不能为空', async () => {
    await expect(weatherTool.execute({})).rejects.toThrow('location 不能为空')
    await expect(weatherTool.execute({ location: '   ' })).rejects.toThrow('location 不能为空')
  })
})

// ── days clamp ───────────────────────────────────────────

describe('weatherTool.execute days clamp', () => {
  const baseForecast = { current: { temperature_2m: 20 }, daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] } }

  it('days < 1 → 1', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4 })
    mockForecast(baseForecast)
    await weatherTool.execute({ location: '北京', days: 0 })
    // forecast_days=1 应出现在第二次 safeFetch 调用 url
    expect(String(mockSafeFetch.mock.calls[1]![0]!)).toContain('forecast_days=1')
  })

  it('days > 3 → 3', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4 })
    mockForecast(baseForecast)
    await weatherTool.execute({ location: '北京', days: 10 })
    expect(String(mockSafeFetch.mock.calls[1]![0]!)).toContain('forecast_days=3')
  })

  it('days 1-3 → 透传', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4 })
    mockForecast(baseForecast)
    await weatherTool.execute({ location: '北京', days: 2 })
    expect(String(mockSafeFetch.mock.calls[1]![0]!)).toContain('forecast_days=2')
  })

  it('days 非数字 → 1', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4 })
    mockForecast(baseForecast)
    await weatherTool.execute({ location: '北京', days: 'abc' })
    expect(String(mockSafeFetch.mock.calls[1]![0]!)).toContain('forecast_days=1')
  })
})

// ── geocode 错误分支 ─────────────────────────────────────

describe('weatherTool.execute geocode 错误分支', () => {
  it('geocode 非 200 → 抛 地理编码服务返回 HTTP', async () => {
    mockGeocodeRaw('{}', 500)
    await expect(weatherTool.execute({ location: 'x' })).rejects.toThrow('地理编码服务返回 HTTP 500')
  })

  it('geocode 无效 JSON → 抛 地理编码服务返回了无效的 JSON', async () => {
    mockGeocodeRaw('not-json{')
    await expect(weatherTool.execute({ location: 'x' })).rejects.toThrow('地理编码服务返回了无效的 JSON')
  })

  it('geocode results 空 → 抛 未找到地点', async () => {
    mockGeocodeRaw(JSON.stringify({ results: [] }))
    await expect(weatherTool.execute({ location: '不存在地' })).rejects.toThrow('未找到地点「不存在地」')
  })
})

// ── forecast 错误分支 ─────────────────────────────────────

describe('weatherTool.execute forecast 错误分支', () => {
  it('forecast 非 200 → 抛 天气服务返回 HTTP', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4 })
    mockGeocodeRaw('not-json{', 500) // 第二次 safeFetch 调用 forecast
    await expect(weatherTool.execute({ location: '北京' })).rejects.toThrow('天气服务返回 HTTP 500')
  })

  it('forecast 无效 JSON → 抛 天气服务返回了无效的 JSON', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4 })
    mockGeocodeRaw('not-json{') // status 默认 200，但 body 非法
    await expect(weatherTool.execute({ location: '北京' })).rejects.toThrow('天气服务返回了无效的 JSON')
  })
})

// ── 正常流程与输出结构 ───────────────────────────────────

describe('weatherTool.execute 正常流程', () => {
  it('完整 current + daily → 输出 location/current/daily/unit', async () => {
    mockGeocode({ name: '北京', latitude: 39.9, longitude: 116.4, country: '中国', admin1: '北京市' })
    mockForecast({
      current: {
        temperature_2m: 20.5,
        apparent_temperature: 18,
        relative_humidity_2m: 45,
        weather_code: 0,
        wind_speed_10m: 3.2,
        precipitation: 0
      },
      daily: {
        time: ['2026-09-28', '2026-09-29'],
        weather_code: [0, 45],
        temperature_2m_max: [22, 19],
        temperature_2m_min: [10, 9],
        precipitation_sum: [0, 0.5]
      }
    })
    const out = JSON.parse(await weatherTool.execute({ location: '北京', days: 2 }))
    expect(out.location).toEqual({ name: '北京', admin1: '北京市', country: '中国' })
    expect(out.unit).toBe('°C')
    expect(out.current).toEqual({
      temperature: 20.5,
      feelsLike: 18,
      humidity: 45,
      windSpeed: 3.2,
      precipMm: 0,
      weather: '晴' // WMO 0
    })
    expect(out.daily).toHaveLength(2)
    expect(out.daily[0]).toEqual({
      date: '2026-09-28',
      weather: '晴',
      maxTemp: 22,
      minTemp: 10,
      precipMm: 0
    })
    expect(out.daily[1].weather).toBe('雾') // WMO 45
  })

  it('current 缺失 → current: null', async () => {
    mockGeocode({ name: 'x', latitude: 1, longitude: 2 })
    mockForecast({ daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] } })
    const out = JSON.parse(await weatherTool.execute({ location: 'x' }))
    expect(out.current).toBeNull()
  })

  it('daily 缺失 → daily: []', async () => {
    mockGeocode({ name: 'x', latitude: 1, longitude: 2 })
    mockForecast({ current: { temperature_2m: 5 } })
    const out = JSON.parse(await weatherTool.execute({ location: 'x' }))
    expect(out.daily).toEqual([])
  })

  it('未知 WMO 码 → "未知天气码(XXX)"', async () => {
    mockGeocode({ name: 'x', latitude: 1, longitude: 2 })
    mockForecast({ current: { weather_code: 999 } })
    const out = JSON.parse(await weatherTool.execute({ location: 'x' }))
    expect(out.current.weather).toBe('未知天气码(999)')
  })

  it('WMO 码非数字 → "未知"', async () => {
    mockGeocode({ name: 'x', latitude: 1, longitude: 2 })
    mockForecast({ current: {} }) // weather_code 缺失 → undefined
    const out = JSON.parse(await weatherTool.execute({ location: 'x' }))
    expect(out.current.weather).toBe('未知')
  })

  it('country/admin1 缺失 → null', async () => {
    mockGeocode({ name: 'x', latitude: 1, longitude: 2 })
    mockForecast({ current: { weather_code: 95 } })
    const out = JSON.parse(await weatherTool.execute({ location: 'x' }))
    expect(out.location.country).toBeNull()
    expect(out.location.admin1).toBeNull()
    expect(out.current.weather).toBe('雷阵雨') // WMO 95
  })
})
