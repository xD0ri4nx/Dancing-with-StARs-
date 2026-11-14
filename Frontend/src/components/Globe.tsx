import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import {
  Viewer,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CallbackProperty,
  CustomDataSource,
  HeightReference,
  PolygonHierarchy,
  ScreenSpaceEventType,
  ArcGisMapServerImageryProvider,
  Math as CesiumMath,
} from 'cesium'

import 'cesium/Build/Cesium/Widgets/widgets.css'

export type ParcelGeoJSON = {
  type: 'Feature'
  properties: {
    id: string
    name: string
  }
  geometry: {
    type: 'Polygon'
    coordinates: number[][][]
  }
}

type GlobeProps = {
  onParcelSelect: (parcel: ParcelGeoJSON | null) => void
}

type DrawMode = 'rectangle' | 'polygon'

type DrawingControls = {
  start: (mode: DrawMode) => void
  finish: () => void
  undo: () => void
  clear: () => void
}

const DRAW_COLOR = Color.fromCssColorString('#22d3ee')
const COMPLETE_COLOR = Color.fromCssColorString('#34d399')
const PREVIEW_COLOR = Color.fromCssColorString('#fbbf24')

// Practical zoom limit to reduce excessive image enlargement.
// Image resolution still depends on the selected geographic area.
const MIN_ZOOM_DISTANCE_METERS = 300

function createRectangleCorners(
  first: Cartesian3,
  second: Cartesian3
): Cartesian3[] | null {
  const a = Cartographic.fromCartesian(first)
  const b = Cartographic.fromCartesian(second)

  const west = Math.min(a.longitude, b.longitude)
  const east = Math.max(a.longitude, b.longitude)
  const south = Math.min(a.latitude, b.latitude)
  const north = Math.max(a.latitude, b.latitude)

  if (
    Math.abs(east - west) < 1e-8 ||
    Math.abs(north - south) < 1e-8
  ) {
    return null
  }

  return [
    Cartesian3.fromRadians(west, south),
    Cartesian3.fromRadians(east, south),
    Cartesian3.fromRadians(east, north),
    Cartesian3.fromRadians(west, north),
  ]
}

function createParcelGeoJSON(
  positions: Cartesian3[]
): ParcelGeoJSON {
  const ring: [number, number][] = positions.map((position) => {
    const point = Cartographic.fromCartesian(position)

    return [
      Number(CesiumMath.toDegrees(point.longitude).toFixed(7)),
      Number(CesiumMath.toDegrees(point.latitude).toFixed(7)),
    ]
  })

  // GeoJSON polygon rings must be closed.
  ring.push([...ring[0]])

  return {
    type: 'Feature',
    properties: {
      id: `parcel-${Date.now()}`,
      name: 'Selected Parcel',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  }
}

const buttonStyle: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #37506e',
  borderRadius: 8,
  background: '#203753',
  color: '#ffffff',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: 13,
  width: '100%',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: '#1297dc',
  borderColor: '#1297dc',
}

const successButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: '#087f5b',
  borderColor: '#087f5b',
}

export default function Globe({
  onParcelSelect,
}: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)

  const verticesRef = useRef<Cartesian3[]>([])
  const hoverRef = useRef<Cartesian3 | null>(null)
  const drawingRef = useRef(false)
  const modeRef = useRef<DrawMode>('polygon')

  const controlsRef = useRef<DrawingControls | null>(null)
  const onParcelSelectRef = useRef(onParcelSelect)

  const [isDrawing, setIsDrawing] = useState(false)
  const [activeMode, setActiveMode] =
    useState<DrawMode>('polygon')

  const [pointCount, setPointCount] = useState(0)
  const [hasSelection, setHasSelection] = useState(false)

  const [message, setMessage] = useState(
    'Choose a drawing tool to select a parcel.'
  )

  useEffect(() => {
    onParcelSelectRef.current = onParcelSelect
  }, [onParcelSelect])

  useEffect(() => {
    if (!containerRef.current) return

    let disposed = false

    const viewer = new Viewer(containerRef.current, {
      baseLayer: false,
      baseLayerPicker: false,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      fullscreenButton: false,

      // Render using the display's actual pixel density.
      useBrowserRecommendedResolution: false,
    })

    viewerRef.current = viewer

    // Modest supersampling for the canvas.
    // This does not increase the satellite image's native resolution.
    viewer.resolutionScale = 1.25

    const { scene } = viewer
    const { globe, screenSpaceCameraController } = scene

    // Lower values request finer levels of detail.
    globe.maximumScreenSpaceError = 0.5

    // Keep more tiles available while navigating.
    globe.tileCacheSize = 512
    globe.preloadSiblings = true
    globe.preloadAncestors = true

    globe.show = true
    globe.baseColor = Color.fromCssColorString('#285d91')
    scene.backgroundColor = Color.BLACK

    // Avoid the severe overzoom previously allowed at 3 meters.
    screenSpaceCameraController.minimumZoomDistance =
      MIN_ZOOM_DISTANCE_METERS

    // More controlled zoom near the surface.
    screenSpaceCameraController.zoomFactor = 2
    screenSpaceCameraController.inertiaZoom = 0.5

    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(
        24.9,
        45.9,
        1500000
      ),
    })

    const parcelSource = new CustomDataSource('parcel-editor')
    void viewer.dataSources.add(parcelSource)

    const entities = parcelSource.entities

    async function loadImagery() {
      try {
        // Cesium reads the supported tile levels from service metadata.
        const provider =
          await ArcGisMapServerImageryProvider.fromUrl(
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
            {
              enablePickFeatures: false,
            }
          )

        if (disposed || viewer.isDestroyed()) return

        viewer.imageryLayers.addImageryProvider(provider)
      } catch (error) {
        if (!disposed) {
          console.error('Satellite imagery error:', error)

          setMessage(
            'Satellite imagery could not be loaded. Reload to try again.'
          )
        }
      }
    }

    // Load a single imagery layer.
    void loadImagery()

    function addMarkers(
      positions: Cartesian3[],
      color: Color
    ) {
      for (const position of positions) {
        entities.add({
          position,
          point: {
            pixelSize: 10,
            color,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      }
    }

    function renderDraft() {
      entities.removeAll()

      const vertices = verticesRef.current

      if (modeRef.current === 'polygon') {
        if (vertices.length >= 3) {
          entities.add({
            polygon: {
              hierarchy: new PolygonHierarchy(vertices),
              material: DRAW_COLOR.withAlpha(0.22),
            },
          })
        }

        if (vertices.length >= 2) {
          entities.add({
            polyline: {
              positions: [...vertices],
              width: 3,
              material: DRAW_COLOR,
              clampToGround: true,
            },
          })
        }

        if (vertices.length >= 1) {
          entities.add({
            polyline: {
              positions: new CallbackProperty(() => {
                const current = verticesRef.current
                const hover = hoverRef.current

                if (
                  !drawingRef.current ||
                  !hover ||
                  current.length === 0
                ) {
                  return []
                }

                return [
                  current[current.length - 1],
                  hover,
                ]
              }, false),
              width: 2,
              material: PREVIEW_COLOR,
              clampToGround: true,
            },
          })
        }
      }

      if (
        modeRef.current === 'rectangle' &&
        vertices.length === 1
      ) {
        entities.add({
          polyline: {
            positions: new CallbackProperty(() => {
              const hover = hoverRef.current

              if (!drawingRef.current || !hover) {
                return []
              }

              const corners = createRectangleCorners(
                verticesRef.current[0],
                hover
              )

              return corners
                ? [...corners, corners[0]]
                : []
            }, false),
            width: 3,
            material: PREVIEW_COLOR,
            clampToGround: true,
          },
        })
      }

      addMarkers(vertices, DRAW_COLOR)
    }

    function renderCompleted(positions: Cartesian3[]) {
      entities.removeAll()

      entities.add({
        polygon: {
          hierarchy: new PolygonHierarchy(positions),
          material: COMPLETE_COLOR.withAlpha(0.28),
        },
      })

      entities.add({
        polyline: {
          positions: [...positions, positions[0]],
          width: 4,
          material: COMPLETE_COLOR,
          clampToGround: true,
        },
      })

      addMarkers(positions, COMPLETE_COLOR)
    }

    function finishWithPositions(positions: Cartesian3[]) {
      if (positions.length < 3) return

      drawingRef.current = false
      hoverRef.current = null

      viewer.canvas.style.cursor = 'default'
      verticesRef.current = [...positions]

      setIsDrawing(false)
      setHasSelection(true)
      setPointCount(positions.length)

      renderCompleted(positions)

      onParcelSelectRef.current(
        createParcelGeoJSON(positions)
      )

      setMessage(
        `Parcel selected successfully (${positions.length} vertices).`
      )
    }

    function finishPolygon() {
      if (!drawingRef.current) return
      if (modeRef.current !== 'polygon') return

      if (verticesRef.current.length < 3) {
        setMessage(
          'Add at least 3 vertices before finishing.'
        )
        return
      }

      finishWithPositions([...verticesRef.current])
    }

    function startDrawing(mode: DrawMode) {
      modeRef.current = mode
      drawingRef.current = true

      verticesRef.current = []
      hoverRef.current = null

      entities.removeAll()
      viewer.canvas.style.cursor = 'crosshair'

      setActiveMode(mode)
      setIsDrawing(true)
      setHasSelection(false)
      setPointCount(0)

      onParcelSelectRef.current(null)

      if (mode === 'rectangle') {
        setMessage(
          'Click the first corner, then click the opposite corner.'
        )
      } else {
        setMessage(
          'Click to add vertices. Double-click or press Enter to finish.'
        )
      }
    }

    function undoLastPoint() {
      if (!drawingRef.current) return

      if (verticesRef.current.length === 0) {
        setMessage('No vertices to undo.')
        return
      }

      verticesRef.current.pop()
      hoverRef.current = null

      setPointCount(verticesRef.current.length)
      renderDraft()

      setMessage(
        `${verticesRef.current.length} vertices remaining.`
      )
    }

    function clearSelection() {
      drawingRef.current = false
      verticesRef.current = []
      hoverRef.current = null

      entities.removeAll()
      viewer.canvas.style.cursor = 'default'

      setIsDrawing(false)
      setHasSelection(false)
      setPointCount(0)

      onParcelSelectRef.current(null)

      setMessage(
        'Selection cleared. Choose a drawing tool.'
      )
    }

    controlsRef.current = {
      start: startDrawing,
      finish: finishPolygon,
      undo: undoLastPoint,
      clear: clearSelection,
    }

    let lastClickPosition: Cartesian2 | null = null

    function handleMapClick(screenPosition: Cartesian2) {
      if (!drawingRef.current) return

      const worldPosition = viewer.camera.pickEllipsoid(
        screenPosition,
        globe.ellipsoid
      )

      if (!worldPosition) return

      // Avoid duplicate vertices from double-clicks.
      if (
        lastClickPosition &&
        Cartesian2.distance(
          lastClickPosition,
          screenPosition
        ) < 8
      ) {
        return
      }

      lastClickPosition = Cartesian2.clone(screenPosition)

      if (modeRef.current === 'rectangle') {
        if (verticesRef.current.length === 0) {
          verticesRef.current.push(worldPosition)

          setPointCount(1)
          renderDraft()

          setMessage(
            'Move the cursor and click the opposite corner.'
          )

          return
        }

        const corners = createRectangleCorners(
          verticesRef.current[0],
          worldPosition
        )

        if (!corners) {
          setMessage(
            'Rectangle is too small. Choose another corner.'
          )
          return
        }

        finishWithPositions(corners)
        return
      }

      verticesRef.current.push(worldPosition)

      setPointCount(verticesRef.current.length)
      renderDraft()

      if (verticesRef.current.length < 3) {
        setMessage(
          `${verticesRef.current.length} vertices added. Minimum 3 required.`
        )
      } else {
        setMessage(
          `${verticesRef.current.length} vertices. Double-click or press Enter to finish.`
        )
      }
    }

    viewer.screenSpaceEventHandler.setInputAction(
      (event: { position: Cartesian2 }) => {
        handleMapClick(event.position)
      },
      ScreenSpaceEventType.LEFT_CLICK
    )

    viewer.screenSpaceEventHandler.setInputAction(
      (event: { position: Cartesian2 }) => {
        if (
          !drawingRef.current ||
          modeRef.current !== 'polygon'
        ) {
          return
        }

        handleMapClick(event.position)
        finishPolygon()
      },
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK
    )

    viewer.screenSpaceEventHandler.setInputAction(
      (event: { endPosition: Cartesian2 }) => {
        if (!drawingRef.current) return

        hoverRef.current =
          viewer.camera.pickEllipsoid(
            event.endPosition,
            globe.ellipsoid
          ) ?? null

        scene.requestRender()
      },
      ScreenSpaceEventType.MOUSE_MOVE
    )

    function handleKeyDown(event: KeyboardEvent) {
      if (!drawingRef.current) return

      const target = event.target

      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, select, [contenteditable="true"]'
        )
      ) {
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        clearSelection()
      }

      if (
        event.key === 'Enter' &&
        modeRef.current === 'polygon'
      ) {
        event.preventDefault()
        finishPolygon()
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault()
        undoLastPoint()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      disposed = true

      window.removeEventListener(
        'keydown',
        handleKeyDown
      )

      drawingRef.current = false
      controlsRef.current = null
      viewerRef.current = null

      if (!viewer.isDestroyed()) {
        viewer.destroy()
      }
    }
  }, [])

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
      }}
    >
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 20,
          left: 20,
          zIndex: 10,
          width: 290,
          maxWidth: 'calc(100% - 40px)',
          background: 'rgba(9, 22, 42, 0.96)',
          border: '1px solid #30455f',
          borderRadius: 12,
          padding: 16,
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              marginBottom: 5,
            }}
          >
            Parcel Selection
          </div>

          <div
            style={{
              fontSize: 12,
              color: '#9eb5ce',
              lineHeight: 1.5,
            }}
          >
            Draw an area to analyze satellite changes.
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
          }}
        >
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() =>
              controlsRef.current?.start('rectangle')
            }
          >
            Rectangle
          </button>

          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() =>
              controlsRef.current?.start('polygon')
            }
          >
            Polygon
          </button>
        </div>

        <div
          role="status"
          style={{
            padding: 10,
            borderRadius: 8,
            background: '#13263f',
            border: '1px solid #2d445f',
            fontSize: 12,
            lineHeight: 1.6,
            color: '#cbd5e1',
          }}
        >
          {message}
        </div>

        {isDrawing && (
          <>
            <div
              style={{
                fontSize: 12,
                color: '#9eb5ce',
              }}
            >
              Mode:{' '}
              {activeMode === 'polygon'
                ? 'Custom Polygon'
                : 'Quick Rectangle'}
              {' · '}
              Points: {pointCount}
            </div>

            {activeMode === 'polygon' && (
              <button
                type="button"
                style={{
                  ...successButtonStyle,
                  opacity: pointCount < 3 ? 0.5 : 1,
                  cursor:
                    pointCount < 3
                      ? 'not-allowed'
                      : 'pointer',
                }}
                disabled={pointCount < 3}
                onClick={() =>
                  controlsRef.current?.finish()
                }
              >
                Finish Polygon
              </button>
            )}

            <button
              type="button"
              style={buttonStyle}
              disabled={pointCount === 0}
              onClick={() =>
                controlsRef.current?.undo()
              }
            >
              Undo Last Point
            </button>

            <button
              type="button"
              style={buttonStyle}
              onClick={() =>
                controlsRef.current?.clear()
              }
            >
              Cancel Drawing
            </button>
          </>
        )}

        {hasSelection && !isDrawing && (
          <div
            style={{
              color: '#34d399',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Parcel ready for analysis
          </div>
        )}

        {hasSelection && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() =>
              controlsRef.current?.clear()
            }
          >
            Clear Selection
          </button>
        )}

        <div
          style={{
            borderTop: '1px solid #30455f',
            paddingTop: 10,
            fontSize: 11,
            color: '#8ca3bd',
            lineHeight: 1.7,
          }}
        >
          Click: add a point
          {' · '}
          Double-click: finish polygon
          {' · '}
          Ctrl+Z: undo
          {' · '}
          Esc: cancel
        </div>
      </div>
    </div>
  )
}