
import { useState } from 'react'

import Globe, {
  type ParcelGeoJSON,
} from './components/Globe'

import './App.css'

type AnalysisType = 'surface' | 'flood' | 'vegetation'

const analysisLabels: Record<AnalysisType, string> = {
  surface: 'Surface Changes',
  flood: 'Flood Detection',
  vegetation: 'Vegetation Changes',
}

const demoDescriptions: Record<AnalysisType, string> = {
  surface:
    'This parcel is ready for surface change detection. ' +
    'Once the NISAR pipeline is connected, the system will ' +
    'compare radar observations from the selected dates ' +
    'to identify potential changes in the land surface.',

  flood:
    'This parcel is ready for flood detection. ' +
    'The future SAR analysis will examine changes in radar ' +
    'backscatter that may indicate water accumulation or flooding.',

  vegetation:
    'This parcel is ready for vegetation change detection. ' +
    'The future analysis will compare radar measurements ' +
    'to identify possible changes in vegetation structure ' +
    'and land cover.',
}

function App() {
  const [startDate, setStartDate] = useState('2026-07-01')
  const [endDate, setEndDate] = useState('2026-11-01')

  const [analysisType, setAnalysisType] =
    useState<AnalysisType>('surface')

  const [status, setStatus] = useState(
    'Ready to configure an analysis.'
  )

  const [selectedParcel, setSelectedParcel] =
    useState<ParcelGeoJSON | null>(null)

  const [analysisResult, setAnalysisResult] =
    useState<string | null>(null)

  // --------------------------------------------------
  // Handle parcel selection
  // --------------------------------------------------

  function handleParcelSelect(
    parcel: ParcelGeoJSON | null
  ) {
    setSelectedParcel(parcel)
    setAnalysisResult(null)

    if (parcel) {
      setStatus(
        'Parcel selected successfully. Ready for analysis.'
      )
    } else {
      setStatus(
        'Select a parcel on the globe to start an analysis.'
      )
    }
  }

  // --------------------------------------------------
  // Analyze selected parcel
  // --------------------------------------------------

  function handleAnalyze() {
    setAnalysisResult(null)

    if (!selectedParcel) {
      setStatus(
        'Please select a parcel on the globe first.'
      )
      return
    }

    if (!startDate || !endDate) {
      setStatus('Please select both dates.')
      return
    }

    if (startDate > endDate) {
      setStatus(
        'Start date must be before end date.'
      )
      return
    }

    // TODO: Replace this demonstration with FastAPI.
    //
    // Expected request body:
    // {
    //   parcel: selectedParcel,
    //   start_date: startDate,
    //   end_date: endDate,
    //   analysis_type: analysisType
    // }

    setStatus(
      `Demo analysis prepared: ${analysisLabels[analysisType]}`
    )

    setAnalysisResult(demoDescriptions[analysisType])
  }

  // --------------------------------------------------
  // Copy GeoJSON
  // --------------------------------------------------

  async function handleCopyGeoJSON() {
    if (!selectedParcel) return

    try {
      await navigator.clipboard.writeText(
        JSON.stringify(selectedParcel, null, 2)
      )

      setStatus('Parcel GeoJSON copied to clipboard.')
    } catch {
      setStatus('Could not copy GeoJSON.')
    }
  }

  // --------------------------------------------------
  // Download GeoJSON
  // --------------------------------------------------

  function handleDownloadGeoJSON() {
    if (!selectedParcel) return

    const content = JSON.stringify(
      selectedParcel,
      null,
      2
    )

    const blob = new Blob([content], {
      type: 'application/geo+json',
    })

    const url = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = url
    link.download = 'selected-parcel.geojson'
    link.click()

    URL.revokeObjectURL(url)

    setStatus('Parcel GeoJSON downloaded.')
  }

  const vertexCount = selectedParcel
    ? selectedParcel.geometry.coordinates[0].length - 1
    : 0

  // --------------------------------------------------
  // Interface
  // --------------------------------------------------

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <span className="eyebrow">
            NASA SPACE APPS 2026
          </span>

          <h1>Dancing with StARs</h1>

          <p>
            NISAR Satellite Change Detection
          </p>
        </header>

        <section className="section">
          <h2>Analysis Settings</h2>

          <label htmlFor="start-date">
            Start Date
          </label>

          <input
            id="start-date"
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value)
              setAnalysisResult(null)
            }}
          />

          <label htmlFor="end-date">
            End Date
          </label>

          <input
            id="end-date"
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value)
              setAnalysisResult(null)
            }}
          />

          <label htmlFor="analysis-type">
            Analysis Type
          </label>

          <select
            id="analysis-type"
            value={analysisType}
            onChange={(event) => {
              setAnalysisType(
                event.target.value as AnalysisType
              )

              setAnalysisResult(null)
            }}
          >
            <option value="surface">
              Surface Changes
            </option>

            <option value="flood">
              Flood Detection
            </option>

            <option value="vegetation">
              Vegetation Changes
            </option>
          </select>

          <button
            type="button"
            onClick={handleAnalyze}
          >
            Analyze Changes
          </button>

          <div className="status-panel" role="status">
            <span className="status-title">
              ANALYSIS STATUS
            </span>

            <p>{status}</p>
          </div>

          <div className="status-panel">
            <span className="status-title">
              SELECTED PARCEL
            </span>

            {selectedParcel ? (
              <div className="parcel-details">
                <p>
                  <strong>
                    {selectedParcel.properties.name}
                  </strong>
                </p>

                <p>
                  Vertices: {vertexCount}
                </p>

                <p>
                  Geometry: GeoJSON Polygon
                </p>

                <p
                  style={{
                    color: '#34d399',
                    fontWeight: 600,
                  }}
                >
                  Ready for analysis
                </p>

                <button
                  type="button"
                  onClick={() => {
                    void handleCopyGeoJSON()
                  }}
                  style={{
                    width: '100%',
                    marginTop: 10,
                    background: '#243b58',
                  }}
                >
                  Copy GeoJSON
                </button>

                <button
                  type="button"
                  onClick={handleDownloadGeoJSON}
                  style={{
                    width: '100%',
                    marginTop: 8,
                    background: '#243b58',
                  }}
                >
                  Download GeoJSON
                </button>
              </div>
            ) : (
              <p>
                Select a rectangle or draw a polygon
                on the globe to begin.
              </p>
            )}
          </div>

          {analysisResult && (
            <div className="status-panel">
              <span className="status-title">
                CHANGE DETECTION RESULTS
              </span>

              <p
                style={{
                  color: '#fbbf24',
                  fontWeight: 700,
                }}
              >
                DEMONSTRATION ONLY
              </p>

              <p>{analysisResult}</p>

              <p
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: '#94a3b8',
                }}
              >
                No real NISAR processing has
                been performed yet.
              </p>
            </div>
          )}
        </section>

        <footer className="footer">
          Powered by NASA NISAR
          <span> • Hackathon Prototype</span>
        </footer>
      </aside>

      <main className="map-container">
        <Globe
          onParcelSelect={handleParcelSelect}
        />

        <div className="map-label">
          <span className="live-dot" />
          INTERACTIVE 3D EARTH
        </div>

        <div className="map-hint">
          Drag to rotate · Scroll to zoom
        </div>
      </main>
    </div>
  )
}

export default App
