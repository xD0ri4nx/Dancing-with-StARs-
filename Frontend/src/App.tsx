import {
  useEffect,
  useRef,
  useState,
} from 'react'

import Globe from './components/Globe'

import type {
  DrawingState,
  DrawMode,
  GlobeHandle,
  ParcelGeoJSON,
} from './components/Globe'

import PlaceSearch from './components/PlaceSearch'
import type { Place } from './components/PlaceSearch'

import {
  analyzeSelection,
  createAnalysisPlan,
} from './analysis'

import type {
  AnalysisProgress,
  AnalysisReport,
} from './analysis'

import './App.css'
import './experience.css'

function downloadJSON(
  value: unknown,
  filename: string
) {
  const url = URL.createObjectURL(
    new Blob(
      [JSON.stringify(value, null, 2)],
      {
        type: 'application/geo+json',
      }
    )
  )

  const link = document.createElement('a')

  link.href = url
  link.download = filename

  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(
    () => URL.revokeObjectURL(url),
    1000
  )
}

function formatNumber(
  value: number,
  digits = 2
) {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: digits,
  })
}

function Icon({
  name,
}: {
  name: 'earth' | 'target' | 'arrow'
}) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'earth' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <ellipse
            cx="12"
            cy="12"
            rx="3.5"
            ry="8"
          />
          <path d="M4 12h16" />
        </>
      )}

      {name === 'target' && (
        <>
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="1.5" />
          <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
        </>
      )}

      {name === 'arrow' && (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      )}
    </svg>
  )
}

export default function App() {
  const globe = useRef<GlobeHandle>(null)

  const active =
    useRef<AbortController | null>(null)

  const [menuOpen, setMenuOpen] =
    useState(false)

  const [heroVisible, setHeroVisible] =
    useState(true)

  const [place, setPlace] =
    useState<Place | null>(null)

  const [parcel, setParcel] =
    useState<ParcelGeoJSON | null>(null)

  const [report, setReport] =
    useState<AnalysisReport | null>(null)

  const [busy, setBusy] =
    useState(false)

  const [error, setError] =
    useState('')

  const [notice, setNotice] =
    useState('')

  const [showChanges, setShowChanges] =
    useState(true)

  const [startDate, setStartDate] =
    useState('2024-07-01')

  const [endDate, setEndDate] =
    useState('2024-11-30')

  const [visibleRegions, setVisibleRegions] =
    useState(30)

  const [coordinates, setCoordinates] =
    useState({
      west: '',
      south: '',
      east: '',
      north: '',
    })

  const [progress, setProgress] =
    useState<AnalysisProgress>({
      visited: 0,
      cells: 0,
      completed: 0,
      failed: 0,
      status: 'Ready to explore',
      jobId: '',
    })

  const [drawing, setDrawing] =
    useState<DrawingState>({
      mode: null,
      points: 0,
      message:
        'Draw an area or enter its exact coordinates.',
    })

  useEffect(() => {
    return () => {
      active.current?.abort()
    }
  }, [])

  function clearResults() {
    setReport(null)
    setError('')
    setVisibleRegions(30)

    setProgress({
      visited: 0,
      cells: 0,
      completed: 0,
      failed: 0,
      status: 'Ready to explore',
      jobId: '',
    })
  }

  function selectParcel(
    next: ParcelGeoJSON | null
  ) {
    if (active.current) return

    clearResults()
    setParcel(next)

    if (next) {
      setHeroVisible(false)

      if (window.innerWidth >= 760) {
        setMenuOpen(true)
      }
    }
  }

  function beginDrawing(mode: DrawMode) {
    if (busy) return

    setHeroVisible(false)
    globe.current?.startDrawing(mode)

    // Leave the globe unobstructed while drawing.
    setMenuOpen(false)
  }

  function choosePlace(next: Place) {
    if (busy) return

    setPlace(next)
    setHeroVisible(false)

    globe.current?.flyToPlace(next)

    if (next.extent) {
      const [west, north, east, south] =
        next.extent

      setCoordinates({
        west: String(west),
        south: String(south),
        east: String(east),
        north: String(north),
      })
    } else {
      setCoordinates({
        west: '',
        south: '',
        east: '',
        north: '',
      })
    }
  }

  function selectExactBounds() {
    if (busy) return

    const entries = [
      coordinates.west,
      coordinates.south,
      coordinates.east,
      coordinates.north,
    ]

    if (
      entries.some(value =>
        value.trim() === ''
      )
    ) {
      setError(
        'Enter all four coordinates.'
      )
      return
    }

    const values = entries.map(Number)

    if (
      values.some(value =>
        !Number.isFinite(value)
      )
    ) {
      setError(
        'Coordinates must be valid numbers.'
      )
      return
    }

    setError('')
    setHeroVisible(false)

    globe.current?.selectBounds(
      values as [
        number,
        number,
        number,
        number,
      ],
      'Your coordinate selection'
    )
  }

  function selectPlaceExtent() {
    if (
      busy ||
      !place?.extent
    ) {
      return
    }

    const [west, north, east, south] =
      place.extent

    setHeroVisible(false)

    globe.current?.selectBounds(
      [west, south, east, north],
      `${place.name} bounding rectangle`
    )
  }

  async function analyze() {
    if (
      !parcel ||
      active.current ||
      drawing.mode
    ) {
      return
    }

    if (
      !startDate ||
      !endDate ||
      startDate >= endDate
    ) {
      setError(
        'Choose a start date earlier than the end date.'
      )
      return
    }

    const controller =
      new AbortController()

    active.current = controller

    setBusy(true)
    setError('')
    setReport(null)
    setShowChanges(true)
    setHeroVisible(false)
    setVisibleRegions(30)

    setProgress({
      visited: 0,
      cells: 0,
      completed: 0,
      failed: 0,
      status: 'Preparing analysis queue',
      jobId: '',
    })

    try {
      const result = await analyzeSelection(
        parcel.geometry.coordinates[0],
        startDate,
        endDate,
        controller.signal,

        next => {
          if (
            active.current === controller
          ) {
            setProgress(next)
          }
        },

        next => {
          if (
            active.current === controller
          ) {
            setReport(next)
          }
        }
      )

      if (
        active.current !== controller
      ) {
        return
      }

      setReport(result)

      globe.current?.focusParcel()

      // Preserve the open space for result callouts.
      setMenuOpen(false)

      if (
        result.completed === 0 &&
        !controller.signal.aborted
      ) {
        setError(
          result.failures[0] ||
          'No area could be processed. Check coverage, dates, and selection dimensions.'
        )

        setMenuOpen(true)
      }
    } catch (cause) {
      if (
        active.current === controller
      ) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Analysis could not start.'
        )

        setMenuOpen(true)
      }
    } finally {
      if (
        active.current === controller
      ) {
        active.current = null
        setBusy(false)
      }
    }
  }

  function inspectRegion(id: string) {
    setHeroVisible(false)
    setMenuOpen(false)

    globe.current?.inspectRegion(id)
  }

  const plan = parcel
    ? createAnalysisPlan(
        parcel.geometry.coordinates[0]
      )
    : null

  const regions =
    report?.features.features ?? []

  const estimatedChangedArea = regions.reduce(
    (sum, region) =>
      sum + region.properties.area_km2,
    0
  )

  const status = busy
    ? progress.status
    : report
      ? report.stopped ||
        report.failed > 0 ||
        report.skipped > 0
        ? 'Partial analysis available'
        : 'Analysis complete'
      : 'Ready to explore'

  const progressPercent =
    progress.cells > 0
      ? Math.min(
          100,
          progress.visited /
            progress.cells * 100
        )
      : 0

  return (
    <div className="earth-app">
      <Globe
        ref={globe}
        report={report}
        showChanges={showChanges}
        interactive={!busy}
        onParcelSelect={selectParcel}
        onDrawingChange={setDrawing}
        onActivity={() =>
          setHeroVisible(false)
        }
        onMapError={setNotice}
      />

      <div
        className="space-vignette"
        aria-hidden="true"
      />

      <header className="topbar">
        <div className="brand-group">
          <button
            type="button"
            className={`hamburger icon-button ${
              menuOpen
                ? 'hamburger--open'
                : ''
            }`}
            aria-label={
              menuOpen
                ? 'Close parcel workspace'
                : 'Open parcel workspace'
            }
            aria-expanded={menuOpen}
            aria-controls="parcel-workspace"
            onClick={() =>
              setMenuOpen(!menuOpen)
            }
          >
            <span />
            <span />
            <span />
          </button>

          <button
            type="button"
            className="brand"
            aria-label="Return to Earth overview"
            onClick={() => {
              globe.current?.home()

              setHeroVisible(
                !parcel && !report
              )
            }}
          >
            <span
              className="brand-symbol"
              aria-hidden="true"
            >
              ✳
            </span>

            <span>
              <strong>
                Dancing with StARs
                <span className="brand-period">
                  .
                </span>
              </strong>

              <small>
                SPACE APPS 2026 / EARTH OBSERVATION
              </small>
            </span>
          </button>
        </div>

        <span
          className={`top-status ${
            busy ? 'top-status--busy' : ''
          }`}
          role="status"
        >
          <i />
          {status}
        </span>

        <PlaceSearch
          disabled={busy}
          onSelect={choosePlace}
        />
      </header>

      <section
        className={`hero-copy ${
          !heroVisible ||
          menuOpen ||
          Boolean(report)
            ? 'hero-copy--hidden'
            : ''
        }`}
        aria-hidden={
          !heroVisible ||
          menuOpen ||
          Boolean(report)
        }
        inert={
          !heroVisible ||
          menuOpen ||
          Boolean(report)
        }
      >
        <div className="eyebrow">
          <span />
          A NEW PERSPECTIVE ON OUR PLANET
        </div>

        <h1>
          A changing world.
          <br />
          <em>A closer look.</em>
        </h1>

        <p>
          Find a place. Define your area.
          <br />
          Explore the changes between two moments.
        </p>

        <button
          type="button"
          className="hero-action"
          onClick={() =>
            setMenuOpen(true)
          }
        >
          Explore an area
          <Icon name="arrow" />
        </button>
      </section>

      <aside
        id="parcel-workspace"
        className={`workspace ${
          menuOpen
            ? 'workspace--open'
            : ''
        }`}
        aria-label="Parcel workspace"
        aria-hidden={!menuOpen}
        inert={!menuOpen}
      >
        <div className="workspace-header">
          <div>
            <span className="eyebrow">
              YOUR AREA OF INTEREST
            </span>

            <h2>Parcel workspace</h2>
          </div>

          <button
            type="button"
            className="small-icon"
            aria-label="Close workspace"
            onClick={() =>
              setMenuOpen(false)
            }
          >
            &times;
          </button>
        </div>

        <div className="workspace-body">
          <section className="panel-section">
            <div className="section-heading">
              <span>01</span>
              <h3>Define your area</h3>
            </div>

            <p className="muted">
              The globe stays at a fixed distance.
              Draw a broad area, or enter coordinates
              for a precise local parcel.
            </p>

            <div className="tool-grid">
              <button
                type="button"
                className="tool-button"
                disabled={busy}
                onClick={() =>
                  beginDrawing('rectangle')
                }
              >
                <span aria-hidden="true">▭</span>
                <strong>Rectangle</strong>
                <small>Two opposite corners</small>
              </button>

              <button
                type="button"
                className="tool-button"
                disabled={busy}
                onClick={() =>
                  beginDrawing('polygon')
                }
              >
                <span aria-hidden="true">⬡</span>
                <strong>Polygon</strong>
                <small>Your own outline</small>
              </button>
            </div>

            {place?.extent && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={selectPlaceExtent}
              >
                Select {place.name} bounding rectangle
              </button>
            )}

            <details className="coordinate-details">
              <summary>
                Enter exact coordinates
              </summary>

              <p className="muted">
                Decimal degrees. Longitude first.
                This selects a rectangle.
              </p>

              <div className="coordinate-grid">
                {(
                  [
                    'west',
                    'south',
                    'east',
                    'north',
                  ] as const
                ).map(key => (
                  <label key={key}>
                    {key.toUpperCase()}

                    <input
                      type="number"
                      step="any"
                      disabled={busy}
                      value={coordinates[key]}
                      onChange={event =>
                        setCoordinates(current => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>

              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={selectExactBounds}
              >
                Select these coordinates
              </button>
            </details>

            <p
              className={`drawing-instruction ${
                drawing.error
                  ? 'drawing-instruction--error'
                  : ''
              }`}
              role="status"
            >
              {drawing.message}
            </p>

            {parcel && (
              <div className="parcel-card">
                <div className="parcel-card-title">
                  <span className="parcel-dot" />

                  <strong>
                    {parcel.properties.name}
                  </strong>
                </div>

                <div className="parcel-dimensions">
                  <span>
                    <b>
                      {formatNumber(
                        parcel.properties.width_km
                      )}
                    </b>
                    {' '}km wide
                  </span>

                  <span>
                    <b>
                      {formatNumber(
                        parcel.properties.height_km
                      )}
                    </b>
                    {' '}km high
                  </span>
                </div>

                <p className="muted">
                  Approximately{' '}
                  {formatNumber(
                    parcel.properties.area_km2
                  )}
                  {' '}km² selected.
                </p>

                <div className="inline-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      globe.current?.focusParcel()
                    }
                  >
                    Rotate to selection
                  </button>

                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      globe.current?.clear()
                    }
                  >
                    Clear
                  </button>
                </div>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    downloadJSON(
                      parcel,
                      'selected-area.geojson'
                    )
                  }
                >
                  Download selected area
                </button>
              </div>
            )}
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <span>02</span>
              <h3>Compare observations</h3>
            </div>

            <div className="date-grid">
              <label>
                FROM

                <input
                  type="date"
                  value={startDate}
                  disabled={busy}
                  onChange={event => {
                    clearResults()
                    setStartDate(
                      event.target.value
                    )
                  }}
                />
              </label>

              <label>
                TO

                <input
                  type="date"
                  value={endDate}
                  disabled={busy}
                  onChange={event => {
                    clearResults()
                    setEndDate(
                      event.target.value
                    )
                  }}
                />
              </label>
            </div>

            <div className="model-caption">
              <span className="parcel-dot" />
              General surface change
              <small>~30 m SAR</small>
            </div>

            {plan && (
              <div className="queue-preview">
                <strong>
                  {formatNumber(plan.cells, 0)}
                  {' '}grid cell
                  {plan.cells === 1 ? '' : 's'}
                </strong>

                <p>
                  Larger selections are split into
                  smaller backend requests and processed
                  sequentially. Irregular outlines may
                  require more than one request per cell.
                </p>

                {plan.cells > 100 && (
                  <p className="warning-text">
                    This is a large queue. Processing
                    can take substantial time and storage.
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              className="analyze-button"
              disabled={
                busy ||
                !parcel ||
                Boolean(drawing.mode)
              }
              onClick={() => {
                void analyze()
              }}
            >
              {busy ? (
                <>
                  <span className="spinner" />
                  Analyzing selection
                </>
              ) : (
                <>
                  Analyze changes
                  <Icon name="arrow" />
                </>
              )}
            </button>

            {busy && (
              <div
                className="analysis-progress"
                role="status"
              >
                <div className="progress-track">
                  <span
                    style={{
                      width:
                        `${progressPercent}%`,
                    }}
                  />
                </div>

                <strong>
                  {progress.status}
                </strong>

                <p>
                  {formatNumber(
                    progress.visited,
                    0
                  )}
                  {' / '}
                  {formatNumber(
                    progress.cells,
                    0
                  )}
                  {' '}grid cells checked
                </p>

                <p>
                  {progress.completed}
                  {' '}successful requests
                  {' · '}
                  {progress.failed}
                  {' '}failed
                </p>

                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    active.current?.abort()
                  }}
                >
                  Stop scheduling and tracking
                </button>
              </div>
            )}

            {progress.jobId && (
              <a
                className="job-link"
                href={
                  'http://127.0.0.1:3000/api/jobs/' +
                  encodeURIComponent(
                    progress.jobId
                  )
                }
                target="_blank"
                rel="noreferrer"
              >
                View latest backend job
              </a>
            )}

            {error && (
              <div
                className="error-card"
                role="alert"
              >
                {error}
              </div>
            )}
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <span>03</span>
              <h3>Explore detected changes</h3>
            </div>

            {!report ? (
              <p className="muted">
                Results will appear here.
                Click a red region or marker on Earth
                to open its observation card.
              </p>
            ) : (
              <>
                <div className="result-summary">
                  <span>
                    ESTIMATED MAPPED FOOTPRINT
                  </span>

                  <strong>
                    {formatNumber(
                      estimatedChangedArea,
                      3
                    )}

                    <small>km²</small>
                  </strong>
                </div>

                <div className="result-metrics">
                  <div>
                    <b>
                      {formatNumber(
                        regions.length,
                        0
                      )}
                    </b>

                    <span>Mapped fragments</span>
                  </div>

                  <div>
                    <b>
                      {formatNumber(
                        report.completed,
                        0
                      )}
                    </b>

                    <span>Successful requests</span>
                  </div>
                </div>

                <p className="muted">
                  Markers make small regions selectable
                  from this fixed view. Marker size does
                  not represent the size of a change.
                </p>

                {(
                  report.failed > 0 ||
                  report.skipped > 0 ||
                  report.stopped
                ) && (
                  <div className="error-card">
                    <strong>
                      Partial coverage
                    </strong>

                    <p>
                      {report.failed} failed requests.
                      {' '}
                      {report.skipped} fragments were
                      too narrow or unsupported.
                    </p>

                    {report.stopped && (
                      <p>
                        The queue stopped before every
                        grid cell was checked. An active
                        backend job may still be running.
                      </p>
                    )}
                  </div>
                )}

                <label className="layer-toggle">
                  <span>
                    <i />
                    Show detected changes
                  </span>

                  <input
                    type="checkbox"
                    checked={showChanges}
                    onChange={event =>
                      setShowChanges(
                        event.target.checked
                      )
                    }
                  />
                </label>

                {regions.length === 0 ? (
                  <p className="muted">
                    No change polygons are available
                    from the successfully processed
                    portions of this selection.
                  </p>
                ) : (
                  <div className="region-list">
                    {regions
                      .slice(0, visibleRegions)
                      .map((region, index) => (
                        <button
                          key={region.id}
                          type="button"
                          disabled={!showChanges}
                          onClick={() =>
                            inspectRegion(
                              region.id
                            )
                          }
                        >
                          <span className="region-number">
                            {String(index + 1)
                              .padStart(2, '0')}
                          </span>

                          <span>
                            <strong>
                              Surface change
                            </strong>

                            <small>
                              {region.properties.from}
                              {' → '}
                              {region.properties.to}
                            </small>
                          </span>

                          <b>
                            {formatNumber(
                              region.properties.area_km2,
                              3
                            )}
                            <small>km²</small>
                          </b>
                        </button>
                      ))}

                    {regions.length >
                      visibleRegions && (
                      <button
                        type="button"
                        className="load-more"
                        onClick={() =>
                          setVisibleRegions(
                            current =>
                              current + 30
                          )
                        }
                      >
                        Show more regions
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    downloadJSON(
                      report.features,
                      'detected-changes.geojson'
                    )
                  }
                >
                  Download detected changes
                </button>

                {report.failures.length > 0 && (
                  <details className="failure-details">
                    <summary>
                      View processing errors
                    </summary>

                    {report.failures.map(
                      (failure, index) => (
                        <p key={index}>
                          {failure}
                        </p>
                      )
                    )}
                  </details>
                )}
              </>
            )}
          </section>

          <footer className="workspace-footer">
            Sentinel-1 / OPERA RTC-S1 observations.
            Model-estimated surface changes.
            <br />
            Coverage and observation dates vary
            between requests. Climate attribution
            is not provided.
          </footer>
        </div>
      </aside>

      <nav
        className="map-tools"
        aria-label="Earth controls"
      >
        <button
          type="button"
          className="icon-button"
          title="Earth overview"
          aria-label="Earth overview"
          onClick={() =>
            globe.current?.home()
          }
        >
          <Icon name="earth" />
        </button>

        <button
          type="button"
          className="icon-button"
          title="Rotate to selected area"
          aria-label="Rotate to selected area"
          disabled={!parcel}
          onClick={() =>
            globe.current?.focusParcel()
          }
        >
          <Icon name="target" />
        </button>
      </nav>

      {drawing.mode && (
        <div className="drawing-bar">
          <span>
            {drawing.mode === 'rectangle'
              ? 'Place two corners'
              : `${drawing.points} points placed`}
          </span>

          <button
            type="button"
            disabled={!drawing.points}
            onClick={() =>
              globe.current?.undo()
            }
          >
            Undo
          </button>

          {drawing.mode === 'polygon' && (
            <button
              type="button"
              disabled={drawing.points < 3}
              onClick={() =>
                globe.current?.finish()
              }
            >
              Finish
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              globe.current?.clear()
            }
          >
            Cancel
          </button>
        </div>
      )}

      {(
        notice ||
        (
          drawing.error &&
          !menuOpen
        )
      ) && (
        <div
          className="map-notice"
          role="status"
        >
          <span>
            {notice || drawing.message}
          </span>

          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => {
              setNotice('')

              if (drawing.error) {
                setDrawing(current => ({
                  ...current,
                  error: false,
                }))
              }
            }}
          >
            &times;
          </button>
        </div>
      )}

      {report && !menuOpen && (
        <button
          type="button"
          className="results-pill"
          onClick={() =>
            setMenuOpen(true)
          }
        >
          <span />
          {regions.length}
          {' '}mapped fragments
          <Icon name="arrow" />
        </button>
      )}

      <footer className="map-footer">
        <div className="location-caption">
          <span className="parcel-dot" />

          {place?.name || 'Earth overview'}

          <small>
            Drag to rotate
            {' · '}
            Click a change to inspect
          </small>
        </div>

        <div className="fixed-caption">
          FIXED EARTH VIEW
          <span>ZOOM LOCKED</span>
        </div>
      </footer>
    </div>
  )
}