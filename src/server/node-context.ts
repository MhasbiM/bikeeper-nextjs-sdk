import os from 'node:os'
import type { Contexts } from '../core/types'

export function nodeContexts(): Contexts {
  return {
    runtime: { name: 'node', version: process.version },
    os: { name: os.type(), version: os.release() },
    device: { arch: os.arch() },
  }
}
