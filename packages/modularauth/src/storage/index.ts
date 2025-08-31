import type { StorageAdapter } from "../core/types.js"

const SEPARATOR = String.fromCharCode(0x1f)

export function joinKey(key: string[]) {
  return key.join(SEPARATOR)
}

export function splitKey(key: string) {
  return key.split(SEPARATOR)
}

export namespace Storage {
  function encode(key: string[]) {
    return key.map((k) => k.replaceAll(SEPARATOR, ""))
  }
  
  export function get<T>(adapter: StorageAdapter, key: string[]) {
    return adapter.get(encode(key)) as Promise<T | undefined>
  }

  export function set(
    adapter: StorageAdapter,
    key: string[],
    value: any,
    ttl?: number,
  ) {
    const expiry = ttl ? new Date(Date.now() + ttl * 1000) : undefined
    return adapter.set(encode(key), value, expiry)
  }

  export function remove(adapter: StorageAdapter, key: string[]) {
    return adapter.remove(encode(key))
  }

  export function scan<T>(
    adapter: StorageAdapter,
    key: string[],
  ): AsyncIterable<[string[], T]> {
    return adapter.scan(encode(key))
  }
}