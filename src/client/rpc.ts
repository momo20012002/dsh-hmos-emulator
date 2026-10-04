/** The one way the panel talks to the host half: POST JSON, { ok, value } / { ok: false, error }. */
export const API = '/dsh-hmos-emulator/api'

export async function rpc(method: string, body?: any) {
  let res
  try {
    res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    })
  } catch (error) {
    throw new Error(`无法连接宿主端:${error instanceof Error ? error.message : String(error)}`)
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    throw new Error(`宿主返回非 JSON(HTTP ${res.status})`)
  }
  if (json && json.ok === true) return json.value
  const message = json && json.error && json.error.message ? json.error.message : `HTTP ${res.status}`
  throw new Error(message)
}

