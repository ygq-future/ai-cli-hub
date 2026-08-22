export class HttpClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'HttpClientError'
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const raw = await response.text()
  let body: unknown = null
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown
    } catch {
      body = null
    }
  }
  if (!response.ok) {
    const errorBody = isRecord(body) ? body : {}
    throw new HttpClientError(
      typeof errorBody.error === 'string' ? errorBody.error : `Request failed with status ${response.status}`,
      response.status,
      typeof errorBody.code === 'string' ? errorBody.code : null,
    )
  }
  return body as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
