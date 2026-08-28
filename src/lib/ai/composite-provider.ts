/**
 * CompositeAIProvider — routes text/image generation to different backends.
 *
 * Route table:
 *   generateText()                → textProvider (model from user config)
 *   generateImage()               → imageProvider (→ ComfyUI :8188)
 */

import type { AIProvider, ImageOptions, TextOptions } from './types'
import type { PipelineResult } from '@/lib/pipeline-engine'
import { RetryStrategy } from '@/lib/retry'

// Connection error patterns for IFF Proxy
const CONNECTION_ERROR_NAMES = [
  'FetchError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
]

const retryStrategy = new RetryStrategy({
  maxRetries: 2,
  baseDelay: 1000,
  jitter: true,
  retryableErrors: CONNECTION_ERROR_NAMES,
  onRetry: (attempt, error) => {
    console.warn(`[CompositeAIProvider] Retry ${attempt}/${2} after error: ${error.message}`)
  },
})

export class CompositeAIProvider implements AIProvider {
  /** Last pipeline result from imageProvider — callers can read intermediates */
  lastPipelineResult: PipelineResult | null = null

  constructor(
    private textProvider: AIProvider,
    private imageProvider: AIProvider,
    private textFactory: (uploadDir?: string) => AIProvider,
    private imageFactory: (uploadDir?: string) => AIProvider,
  ) {}

  async generateText(prompt: string, options?: TextOptions): Promise<string> {
    const effectiveModel = options?.model

    const generateFn = async () => {
      return this.textProvider.generateText(prompt, {
        ...options,
        model: effectiveModel,
      })
    }

    try {
      return await retryStrategy.execute(generateFn)
    } catch (err) {
      console.error(`[CompositeAIProvider] Text generation failed after retries: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    const result = await this.imageProvider.generateImage(prompt, options)
    // Propagate lastPipelineResult from ComfyUIProvider
    if ('lastPipelineResult' in this.imageProvider) {
      this.lastPipelineResult = (this.imageProvider as any).lastPipelineResult
    }
    return result
  }

  /** Factory for setDefaultAIProvider — creates fresh CompositeAIProvider with upload dir support */
  static createFactory(
    textProvider: AIProvider,
    imageProvider: AIProvider,
    textFactory: (uploadDir?: string) => AIProvider,
    imageFactory: (uploadDir?: string) => AIProvider,
  ): (uploadDir?: string) => CompositeAIProvider {
    return (uploadDir?: string) => {
      if (!uploadDir) return new CompositeAIProvider(textProvider, imageProvider, textFactory, imageFactory)
      return new CompositeAIProvider(
        textFactory(uploadDir),
        imageFactory(uploadDir),
        textFactory,
        imageFactory,
      )
    }
  }
}