import polygonClipping from 'polygon-clipping'
import type { Pair, Polygon } from 'polygon-clipping'

import { runAnalysis } from './api'

const { intersection } = polygonClipping

export type Region = {
  type: 'Feature'
  id: string
  properties: {
    from: string
    to: string
    area_km2: number
    job_id: string
  }
  geometry: {
    type: 'Polygon'
    coordinates: number[][][]
  }
}

export type AnalysisReport = {
  features: {
    type: 'FeatureCollection'
    features: Region[]
  }
  completed: number
  failed: number
  skipped: number
  visited: number
  cells: number
  stopped: boolean
  failures: string[]
}

export type AnalysisProgress = {
  visited: number
  cells: number
  completed: number
  failed: number
  status: string
  jobId: string
}

export function getBounds(
  ring: number[][]
): [number, number, number, number] {
  return [
    Math.min(...ring.map(point => point[0])),
    Math.min(...ring.map(point => point[1])),
    Math.max(...ring.map(point => point[0])),
    Math.max(...ring.map(point => point[1])),
  ]
}

export function estimateAreaKm2(
  ring: number[][]
): number {
  let sum = 0

  for (let index = 0; index < ring.length; index++) {
    const first = ring[index]
    const second = ring[(index + 1) % ring.length]

    sum +=
      ((second[0] - first[0]) * Math.PI / 180) *
      (
        2 +
        Math.sin(first[1] * Math.PI / 180) +
        Math.sin(second[1] * Math.PI / 180)
      )
  }

  return Math.abs(sum) * 6371.0088 ** 2 / 2
}

export function createAnalysisPlan(ring: number[][]) {
  const [west, south, east, north] = getBounds(ring)

  // Conservative spacing: every request remains below
  // the backend's 50 km bounding-box limit.
  const columns = Math.max(
    1,
    Math.ceil((east - west) * 111.32 / 40)
  )

  const rows = Math.max(
    1,
    Math.ceil((north - south) * 110.57 / 40)
  )

  return {
    west,
    south,
    east,
    north,
    columns,
    rows,
    cells: columns * rows,
  }
}

function getPolygons(feature: unknown): Polygon[] {
  if (!feature || typeof feature !== 'object') {
    return []
  }

  const geometry = (
    feature as {
      geometry?: {
        type?: string
        coordinates?: unknown
      }
    }
  ).geometry

  if (geometry?.type === 'Polygon') {
    return [geometry.coordinates as Polygon]
  }

  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates as Polygon[]
  }

  return []
}

export async function analyzeSelection(
  ring: number[][],
  startDate: string,
  endDate: string,
  signal: AbortSignal,
  onProgress: (progress: AnalysisProgress) => void,
  onUpdate: (report: AnalysisReport) => void
): Promise<AnalysisReport> {
  const plan = createAnalysisPlan(ring)

  const report: AnalysisReport = {
    features: {
      type: 'FeatureCollection',
      features: [],
    },
    completed: 0,
    failed: 0,
    skipped: 0,
    visited: 0,
    cells: plan.cells,
    stopped: false,
    failures: [],
  }

  const subject: Polygon = [
    ring.map(point => [point[0], point[1]] as Pair),
  ]

  let jobId = ''

  function publish() {
    onUpdate({
      ...report,
      failures: [...report.failures],
      features: {
        type: 'FeatureCollection',
        features: [...report.features.features],
      },
    })
  }

  function progress(status: string) {
    onProgress({
      visited: report.visited,
      cells: plan.cells,
      completed: report.completed,
      failed: report.failed,
      status,
      jobId,
    })
  }

  try {
    for (let row = 0; row < plan.rows; row++) {
      for (
        let column = 0;
        column < plan.columns;
        column++
      ) {
        signal.throwIfAborted()

        const west =
          plan.west +
          (plan.east - plan.west) *
            column / plan.columns

        const east =
          plan.west +
          (plan.east - plan.west) *
            (column + 1) / plan.columns

        const south =
          plan.south +
          (plan.north - plan.south) *
            row / plan.rows

        const north =
          plan.south +
          (plan.north - plan.south) *
            (row + 1) / plan.rows

        const cell: Polygon = [[
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ]]

        const parts = intersection(subject, cell)

        let partNumber = 0

        for (const part of parts) {
          signal.throwIfAborted()

          const tile = part[0]

          const [
            tileWest,
            tileSouth,
            tileEast,
            tileNorth,
          ] = getBounds(tile)

          const width =
            (tileEast - tileWest) *
            111.32 *
            Math.cos(
              (tileSouth + tileNorth) *
                Math.PI / 360
            )

          const height =
            (tileNorth - tileSouth) * 110.57

          // The inference service needs a minimum raster
          // window. Skipped fragments are reported explicitly.
          if (
            part.length !== 1 ||
            width < 0.6 ||
            height < 0.6 ||
            estimateAreaKm2(tile) < 0.01
          ) {
            report.skipped++
            continue
          }

          const tileId =
            `${row}-${column}-${partNumber++}`

          let terminalStatusReceived = false
          jobId = ''

          progress('Submitting analysis tile')

          try {
            const result = await runAnalysis(
              tile.slice(0, -1),
              startDate,
              endDate,
              signal,
              job => {
                terminalStatusReceived =
                  job.status === 'done' ||
                  job.status === 'error'

                jobId = job.id
                progress(job.message || job.status)
              }
            )

            const regions: Region[] = []

            for (
              const feature of result.features.features
            ) {
              for (const polygon of getPolygons(feature)) {
                const clippedPolygons =
                  intersection(polygon, part)

                for (const clipped of clippedPolygons) {
                  const exteriorArea =
                    estimateAreaKm2(clipped[0])

                  const holeArea = clipped
                    .slice(1)
                    .reduce(
                      (sum, hole) =>
                        sum + estimateAreaKm2(hole),
                      0
                    )

                  const area = Math.max(
                    0,
                    exteriorArea - holeArea
                  )

                  if (area === 0) continue

                  regions.push({
                    type: 'Feature',
                    id: `${tileId}-${regions.length}`,
                    properties: {
                      from: result.from,
                      to: result.to,
                      area_km2: area,
                      job_id: jobId,
                    },
                    geometry: {
                      type: 'Polygon',
                      coordinates: clipped,
                    },
                  })
                }
              }
            }

            report.features.features.push(...regions)
            report.completed++
          } catch (cause) {
            if (signal.aborted) throw cause

            const message =
              cause instanceof Error
                ? cause.message
                : String(cause)

            report.failed++

            if (report.failures.length < 20) {
              report.failures.push(
                `Tile ${tileId}: ${message}`
              )
            }

            // Transport errors can leave a job running.
            // Stop scheduling additional work in that case.
            const serviceProblem =
              /401|403|token|unreachable|os error 2/i
                .test(message)

            if (
              !terminalStatusReceived ||
              serviceProblem
            ) {
              throw cause
            }
          }

          publish()
        }

        report.visited++
        progress('Checking selection coverage')

        // Keep the interface responsive while traversing
        // grid cells outside an irregular polygon.
        if (report.visited % 16 === 0) {
          await new Promise<void>(resolve => {
            setTimeout(resolve, 0)
          })
        }
      }
    }
  } catch (cause) {
    report.stopped = true

    if (!signal.aborted) {
      const message =
        cause instanceof Error
          ? cause.message
          : String(cause)

      if (
        report.failures.length < 20 &&
        !report.failures.some(item =>
          item.includes(message)
        )
      ) {
        report.failures.push(message)
      }
    }
  }

  publish()

  progress(
    report.stopped
      ? 'Analysis queue stopped'
      : 'Analysis queue complete'
  )

  return report
}