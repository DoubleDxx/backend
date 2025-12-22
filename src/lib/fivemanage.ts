import fs from 'fs'
import fetch from 'node-fetch'
import FormData from 'form-data'

export async function uploadToFivemanage(localPath: string, filename: string): Promise<string | null> {
  try {
    const token = process.env.FIVEMANAGE_TOKEN
    if (!token) {
      console.error('Fivemanage upload error: missing FIVEMANAGE_TOKEN')
      return null
    }
    const url = `https://fmapi.net/api/v2/image?apiKey=${encodeURIComponent(token)}`
    const form = new FormData()
    form.append('file', fs.createReadStream(localPath), { filename })
    form.append('metadata', JSON.stringify({ name: filename, description: 'TradeJournal upload' }))
    const headers = { ...form.getHeaders(), Authorization: token }
    const resp = await fetch(url, { method: 'POST', headers, body: form as any })
    if (!resp.ok) {
      let txt = ''
      try { txt = await resp.text() } catch {}
      console.error('Fivemanage upload failed:', resp.status, txt?.slice(0, 200))
      return null
    }
    const data: any = await resp.json().catch(()=>({}))
    if (data?.status === 'ok' && data?.data?.url) return data.data.url
    return data.url || data.downloadUrl || null
  } catch (e) {
    console.error('Fivemanage upload error:', e)
    return null
  }
}
