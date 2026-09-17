import type { PocketAPI } from '../../../preload'

declare global {
  interface Window {
    pocketai: PocketAPI
  }
}

export {}
