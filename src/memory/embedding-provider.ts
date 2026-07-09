import type { AppConfig } from '../config'

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: unknown }>
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  const baseUrl = config.EMBEDDING_API_BASE_URL.replace(/\/+$/, '')

  return {
    async embed(text: string): Promise<number[]> {
      const body: Record<string, unknown> = {
        model: config.EMBEDDING_MODEL,
        input: text,
        encoding_format: 'float',
      }
      if (config.EMBEDDING_MODEL.startsWith('text-embedding-3')) {
        body.dimensions = config.EMBEDDING_DIMENSIONS
      }

      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Embedding API failed: ${res.status} ${detail.slice(0, 500)}`)
      }

      const json = (await res.json()) as EmbeddingResponse
      const embedding = json.data?.[0]?.embedding
      if (!Array.isArray(embedding) || !embedding.every(v => typeof v === 'number')) {
        throw new Error('Embedding API returned invalid embedding payload')
      }
      if (embedding.length !== config.EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding dimension mismatch: expected ${config.EMBEDDING_DIMENSIONS}, got ${embedding.length}`,
        )
      }
      return embedding
    },
  }
}
