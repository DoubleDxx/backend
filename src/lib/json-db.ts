import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

const DATA_DIR = path.join(process.cwd(), 'data')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR)
}

const collections = ['users', 'viewers', 'viewer_avatars', 'brokers', 'accounts', 'strategies', 'tags', 'trades', 'notes', 'instrument_metas', 'wallet_txs', 'exit_legs', 'screenshots']
collections.forEach(c => {
  const p = path.join(DATA_DIR, `${c}.json`)
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]')
})

// Ensure whitelist storage exists but do NOT include it in reset
{
  const p = path.join(DATA_DIR, `whitelist.json`)
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]')
}

export class JsonDb<T extends { id: string }> {
  private filePath: string

  constructor(collectionName: string) {
    this.filePath = path.join(DATA_DIR, `${collectionName}.json`)
    if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, '[]')
    }
  }

  private read(): T[] {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch {
      return []
    }
  }

  private write(data: T[]) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2))
  }

  getAll(): T[] {
    return this.read()
  }

  findFirst(predicate: (item: T) => boolean): T | null {
    const items = this.read()
    return items.find(predicate) || null
  }
  
  find(predicate: (item: T) => boolean): T | null {
    return this.findFirst(predicate)
  }
  
  findMany(predicate?: (item: T) => boolean): T[] {
    const items = this.read()
    if (!predicate) return items
    return items.filter(predicate)
  }

  findUnique(id: string): T | null {
      return this.findFirst(i => i.id === id)
  }

  getById(id: string): T | null {
      return this.findUnique(id)
  }

  create(data: Omit<T, 'id'> & { id?: string }): T {
    const items = this.read()
    const newItem = { ...data, id: data.id || randomUUID() } as T
    items.push(newItem)
    this.write(items)
    return newItem
  }

  update(id: string, data: Partial<T>): T | null {
    const items = this.read()
    const idx = items.findIndex(i => i.id === id)
    if (idx === -1) return null
    const updated = { ...items[idx], ...data }
    items[idx] = updated
    this.write(items)
    return updated
  }

  delete(id: string): boolean {
    const items = this.read()
    const initialLen = items.length
    const filtered = items.filter(i => i.id !== id)
    if (filtered.length === initialLen) return false
    this.write(filtered)
    return true
  }
  
  deleteMany(predicate: (item: T) => boolean) {
      const items = this.read()
      const filtered = items.filter(i => !predicate(i))
      this.write(filtered)
  }
}

export const db = {
  users: new JsonDb<any>('users'),
  viewers: new JsonDb<any>('viewers'),
  viewerAvatars: new JsonDb<any>('viewer_avatars'),
  brokers: new JsonDb<any>('brokers'),
  accounts: new JsonDb<any>('accounts'),
  strategies: new JsonDb<any>('strategies'),
  tags: new JsonDb<any>('tags'),
  trades: new JsonDb<any>('trades'),
  notes: new JsonDb<any>('notes'),
  instrumentMetas: new JsonDb<any>('instrument_metas'),
  walletTxs: new JsonDb<any>('wallet_txs'),
  exitLegs: new JsonDb<any>('exit_legs'),
  screenshots: new JsonDb<any>('screenshots'),
  whitelist: new JsonDb<any>('whitelist'),
  
  reset: () => {
     collections.forEach(c => {
         const p = path.join(DATA_DIR, `${c}.json`)
         fs.writeFileSync(p, '[]')
     })
  }
}
