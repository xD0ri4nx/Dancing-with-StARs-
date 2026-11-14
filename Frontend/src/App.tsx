
import { useState } from 'react'
import Globe from './components/Globe'
import './App.css'

type AnalysisType = 'surface' | 'flood' | 'vegetation'

function App() {
  const [startDate, setStartDate] = useState('2026-07-01')
  const [endDate, setEndDate] = useState('2026-11-01')

  const [analysisType, setAnalysisType] =
    useState<AnalysisType>('surface')

  const [status, setStatus] = useState(
    'Ready to configure an analysis.'
  )

  function handleAnalyze() {
    if (!startDate || !endDate) {
      setStatus('Please select both dates.')
      return
    }

    if (startDate > endDate) {
      setStatus('Start date must be before end date.')
      return
    }

    // TODO: Integrare FastAPI - Oktavian
    setStatus(
      `Demo request: ${analysisType} | ${startDate} → ${endDate}`
    )
  }

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
            onChange={(event) =>
              setStartDate(event.target.value)
            }
          />

          <label htmlFor="end-date">
            End Date
          </label>
          <input
            id="end-date"
            type="date"
            value={endDate}
            onChange={(event) =>
              setEndDate(event.target.value)
            }
          />

          <label htmlFor="analysis-type">
            Analysis Type
          </label>
          <select
            id="analysis-type"
            value={analysisType}
            onChange={(event) =>
              setAnalysisType(
                event.target.value as AnalysisType
              )
            }
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
        </section>

        <footer className="footer">
          Powered by NASA NISAR
          <span> • Hackathon Prototype</span>
        </footer>
      </aside>

      <main className="map-container">
        <Globe />

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
