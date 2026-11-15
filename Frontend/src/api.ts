export type AnalysisResult = {
  from: string
  to: string
  changed_km2: number
  changed_pct: number
  features: {
    type: 'FeatureCollection'
    features: unknown[]
  }
  overlay_png?: string | null
  overlay_bounds?: [number, number, number, number] | null
}

type JobStatus =
  | 'queued'
  | 'searching'
  | 'downloading'
  | 'running'
  | 'done'
  | 'error'

export type AnalysisJob = {
  id: string
  status: JobStatus
  message: string
  error?: string
  result?: AnalysisResult
}

const API_URL = 'http://127.0.0.1:3000'

async function request<T>(
  path: string,
  signal: AbortSignal,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',

    headers:
      body === undefined
        ? undefined
        : { 'Content-Type': 'application/json' },

    body:
      body === undefined
        ? undefined
        : JSON.stringify(body),

    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(30000),
    ]),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`API ${response.status}: ${detail}`)
  }

  return response.json() as Promise<T>
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)

      reject(
        new DOMException('Tracking stopped', 'AbortError')
      )
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, 2000)

    signal.addEventListener('abort', onAbort, {
      once: true,
    })

    if (signal.aborted) onAbort()
  })
}

export async function runAnalysis(
  polygon: number[][],
  startDate: string,
  endDate: string,
  signal: AbortSignal,
  onProgress: (job: AnalysisJob) => void
): Promise<AnalysisResult> {
  const created = await request<{ job_id: string }>(
    '/api/analyze',
    signal,
    {
      polygon,
      start_date: startDate,
      end_date: endDate,
      analysis_type: 'surface',
    }
  )

  if (!created.job_id) {
    throw new Error('API did not return a job ID.')
  }

  const started = Date.now()

  while (true) {
    signal.throwIfAborted()

    const job = await request<AnalysisJob>(
      `/api/jobs/${encodeURIComponent(created.job_id)}`,
      signal
    )

    signal.throwIfAborted()
    onProgress(job)

    if (job.status === 'error') {
      throw new Error(
        job.error || job.message || 'Analysis failed.'
      )
    }

    if (job.status === 'done') {
      if (!job.result) {
        throw new Error('Job finished without a result.')
      }

      return job.result
    }

    if (Date.now() - started > 20 * 60 * 1000) {
      throw new Error(
        'Stopped tracking after 20 minutes. ' +
          'The server job may still be running.'
      )
    }

    await waitForPoll(signal)
  }
}