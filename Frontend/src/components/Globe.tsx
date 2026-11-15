import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

import {
  ArcGisMapServerImageryProvider,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  EllipsoidalOccluder,
  Entity,
  Math as CesiumMath,
  PolygonHierarchy,
  Rectangle,
  SceneMode,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  Viewer,
} from 'cesium'

import type {
  AnalysisReport,
  Region,
} from '../analysis'

import {
  estimateAreaKm2,
  getBounds,
} from '../analysis'

import type { Place } from './PlaceSearch'

import 'cesium/Build/Cesium/Widgets/widgets.css'

/* --------------------------------------------------
   Public types
-------------------------------------------------- */

export type DrawMode =
  | 'rectangle'
  | 'polygon'

export type DrawingState = {
  mode: DrawMode | null
  points: number
  message: string
  error?: boolean
}

export type ParcelGeoJSON = {
  type: 'Feature'

  properties: {
    name: string
    width_km: number
    height_km: number
    area_km2: number
  }

  geometry: {
    type: 'Polygon'
    coordinates: number[][][]
  }
}

export type GlobeHandle = {
  startDrawing: (mode: DrawMode) => void
  finish: () => void
  undo: () => void
  clear: () => void
  home: () => void
  focusParcel: () => void
  flyToPlace: (place: Place) => void

  selectBounds: (
    bounds: [number, number, number, number],
    name?: string
  ) => void

  inspectRegion: (id: string) => void
}

type Props = {
  report: AnalysisReport | null
  showChanges: boolean
  interactive: boolean

  onParcelSelect: (
    parcel: ParcelGeoJSON | null
  ) => void

  onDrawingChange: (
    state: DrawingState
  ) => void

  onActivity: () => void

  onMapError: (
    message: string
  ) => void
}

type OpenCard = {
  region: Region
  anchor: Cartesian3
}

type DragState = {
  id: number
  x: number
  y: number
  distance: number
}

/* --------------------------------------------------
   Appearance and camera settings
-------------------------------------------------- */

const MINT =
  Color.fromCssColorString('#65e4d8')

const RED =
  Color.fromCssColorString('#ff767e')

const GOLD =
  Color.fromCssColorString('#ffd399')

const HOME_LONGITUDE = 18
const HOME_LATITUDE = 12
const HOME_HEIGHT = 6_000_000
const HOME_PITCH = -63

/*
 * Enter 2D when the 3D camera reaches this altitude.
 * Values are in metres.
 */
const ENTER_2D_HEIGHT = 900_000

/*
 * Return to 3D after zooming out in 2D.
 * This should remain larger than ENTER_2D_HEIGHT
 * to prevent the modes from switching repeatedly.
 */
const RETURN_3D_HEIGHT = 2_500_000

const MORPH_DURATION = 1.7

/* --------------------------------------------------
   Geometry helpers
-------------------------------------------------- */

function toCoordinates(
  positions: Cartesian3[]
): number[][] {
  return positions.map(position => {
    const point =
      Cartographic.fromCartesian(position)

    return [
      CesiumMath.toDegrees(point.longitude),
      CesiumMath.toDegrees(point.latitude),
    ]
  })
}

function toPositions(
  ring: number[][]
): Cartesian3[] {
  return ring.map(point =>
    Cartesian3.fromDegrees(
      point[0],
      point[1]
    )
  )
}

function cross(
  a: number[],
  b: number[],
  c: number[]
): number {
  return (
    (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0])
  )
}

function isOnSegment(
  a: number[],
  b: number[],
  point: number[]
): boolean {
  const epsilon = 1e-10

  return (
    Math.abs(cross(a, b, point)) < epsilon &&
    point[0] >= Math.min(a[0], b[0]) - epsilon &&
    point[0] <= Math.max(a[0], b[0]) + epsilon &&
    point[1] >= Math.min(a[1], b[1]) - epsilon &&
    point[1] <= Math.max(a[1], b[1]) + epsilon
  )
}

function intersects(
  a: number[],
  b: number[],
  c: number[],
  d: number[]
): boolean {
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)

  const properIntersection =
    (
      (abC > 0 && abD < 0) ||
      (abC < 0 && abD > 0)
    ) &&
    (
      (cdA > 0 && cdB < 0) ||
      (cdA < 0 && cdB > 0)
    )

  return (
    properIntersection ||
    isOnSegment(a, b, c) ||
    isOnSegment(a, b, d) ||
    isOnSegment(c, d, a) ||
    isOnSegment(c, d, b)
  )
}

function createParcel(
  input: number[][],
  name = 'Your selected area'
): ParcelGeoJSON {
  let ring = input.map(point => [
    point[0],
    point[1],
  ])

  if (
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    ring = ring.slice(0, -1)
  }

  if (ring.length < 3) {
    throw new Error(
      'Place at least three distinct points.'
    )
  }

  if (
    ring.some(point =>
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) >= 90
    )
  ) {
    throw new Error(
      'Use valid longitude and latitude coordinates.'
    )
  }

  const [west, south, east, north] =
    getBounds(ring)

  if (east - west > 180) {
    throw new Error(
      'Split selections crossing the date line into separate areas.'
    )
  }

  for (
    let index = 0;
    index < ring.length;
    index++
  ) {
    const a = ring[index]

    const b =
      ring[(index + 1) % ring.length]

    if (
      Math.hypot(
        a[0] - b[0],
        a[1] - b[1]
      ) < 1e-9
    ) {
      throw new Error(
        'Two adjacent points overlap.'
      )
    }

    for (
      let other = index + 1;
      other < ring.length;
      other++
    ) {
      if (
        other === index + 1 ||
        (
          index === 0 &&
          other === ring.length - 1
        )
      ) {
        continue
      }

      const c = ring[other]

      const d =
        ring[(other + 1) % ring.length]

      if (intersects(a, b, c, d)) {
        throw new Error(
          'The polygon edges cross. Draw a simple outline.'
        )
      }
    }
  }

  const width =
    (east - west) *
    111.32 *
    Math.cos(
      (south + north) * Math.PI / 360
    )

  const height =
    (north - south) * 110.57

  const area =
    estimateAreaKm2(ring)

  if (
    width < 0.6 ||
    height < 0.6 ||
    area < 0.01
  ) {
    throw new Error(
      'Choose an area at least approximately 600 m across each side.'
    )
  }

  ring.push([...ring[0]])

  return {
    type: 'Feature',

    properties: {
      name,
      width_km: width,
      height_km: height,
      area_km2: area,
    },

    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  }
}

function rectangleCoordinates(
  first: Cartesian3,
  second: Cartesian3
): number[][] {
  const [a, b] =
    toCoordinates([first, second])

  const west = Math.min(a[0], b[0])
  const east = Math.max(a[0], b[0])
  const south = Math.min(a[1], b[1])
  const north = Math.max(a[1], b[1])

  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ]
}

function regionAnchor(
  region: Region
): Cartesian3 {
  const point =
    region.geometry.coordinates[0][0]

  return Cartesian3.fromDegrees(
    point[0],
    point[1]
  )
}

/* --------------------------------------------------
   Globe component
-------------------------------------------------- */

const Globe = forwardRef<GlobeHandle, Props>(
  function Globe(props, ref) {
    const container =
      useRef<HTMLDivElement>(null)

    const viewerRef =
      useRef<Viewer | null>(null)

    const actions =
      useRef<GlobeHandle | null>(null)

    const layerRef =
      useRef<CustomDataSource | null>(null)

    const callbacks = useRef(props)

    const regionIndex =
      useRef(new Map<string, Region>())

    const cardsRef =
      useRef<OpenCard[]>([])

    const cardElements =
      useRef(new Map<string, HTMLElement>())

    const cardDrag = useRef<{
      id: string
      pointerId: number
      offsetX: number
      offsetY: number
    } | null>(null)

    const lineElements =
      useRef(new Map<string, SVGPathElement>())

    const anchorElements =
      useRef(new Map<string, SVGCircleElement>())

    const [cards, setCards] =
      useState<OpenCard[]>([])

    const [mapIs2D, setMapIs2D] =
      useState(false)

    useEffect(() => {
      callbacks.current = props
    }, [props])

    const replaceCards = useCallback(
      (next: OpenCard[]) => {
        cardsRef.current = next
        setCards(next)
      },
      []
    )

    const openRegion = useCallback(
      (
        region: Region,
        anchor: Cartesian3
      ) => {
        if (
          cardsRef.current.some(
            item =>
              item.region.id === region.id
          )
        ) {
          return
        }

        const limit =
          window.innerWidth < 760 ? 1 : 2

        const next = [
          ...cardsRef.current,
          {
            region,
            anchor: Cartesian3.clone(anchor),
          },
        ].slice(-limit)

        replaceCards(next)
        callbacks.current.onActivity()
      },
      [replaceCards]
    )

    useImperativeHandle(
      ref,
      () => ({
        startDrawing: mode =>
          actions.current?.startDrawing(mode),

        finish: () =>
          actions.current?.finish(),

        undo: () =>
          actions.current?.undo(),

        clear: () =>
          actions.current?.clear(),

        home: () =>
          actions.current?.home(),

        focusParcel: () =>
          actions.current?.focusParcel(),

        flyToPlace: place =>
          actions.current?.flyToPlace(place),

        selectBounds: (bounds, name) =>
          actions.current?.selectBounds(
            bounds,
            name
          ),

        inspectRegion: id =>
          actions.current?.inspectRegion(id),
      }),
      []
    )

    useEffect(() => {
      if (!container.current) return

      let disposed = false
      let mode: DrawMode | null = null

      let vertices: Cartesian3[] = []
      let hover: Cartesian3 | null = null

      let selected:
        | ParcelGeoJSON
        | null = null

      let drag: DragState | null = null

      let suppressClickUntil = 0

      let previousClick:
        | Cartesian2
        | null = null

      let previousClickTime = 0

      let morphing = false
      let returningHome = false

      /*
       * Prevent immediate mode switching after
       * a morph or an intentional camera flight.
       */
      let transitionCooldownUntil = 0
/*
 * Stores the search destination until the
 * 3D-to-2D transition has completed.
 */
let pendingSearchDestination: Rectangle | null = null

/*
 * A large country may require a 2D camera height
 * above the normal automatic return-to-3D threshold.
 */
let keepSearchView2D = false

function flyToSearchDestination(
  destination: Rectangle
) {
  if (disposed || viewer.isDestroyed()) {
    return
  }

  keepSearchView2D = true

  /*
   * Prevent the automatic mode watcher from
   * interrupting the 2D camera animation.
   */
  transitionCooldownUntil =
    performance.now() + 4000

  camera.cancelFlight()

  camera.flyTo({
    destination,
    duration: 1.8,

    complete: () => {
      transitionCooldownUntil =
        performance.now() + 1000
    },

    cancel: () => {
      transitionCooldownUntil =
        performance.now() + 1000
    },
  })
}
      const viewer = new Viewer(
        container.current,
        {
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
          useBrowserRecommendedResolution: false,
        }
      )

      viewerRef.current = viewer

      const {
        scene,
        camera,
        canvas,
      } = viewer

      const controller =
        scene.screenSpaceCameraController

      canvas.tabIndex = 0
      canvas.style.touchAction = 'none'
      canvas.style.cursor = 'grab'

      viewer.resolutionScale = 1

      scene.backgroundColor =
        Color.fromCssColorString('#03070d')

      scene.globe.baseColor =
        Color.fromCssColorString('#16303b')

      scene.globe.enableLighting = false
      scene.globe.maximumScreenSpaceError = 1
      scene.globe.tileCacheSize = 512
      scene.fog.enabled = false

      if (scene.skyBox) {
        scene.skyBox.show = false
      }

      if (scene.sun) {
        scene.sun.show = false
      }

      if (scene.moon) {
        scene.moon.show = false
      }

      controller.enableTilt = false
      controller.enableLook = false
      controller.enableZoom = true
      controller.minimumZoomDistance = 300
      controller.maximumZoomDistance = 24_000_000

      controller.inertiaZoom = 0.65
      controller.inertiaTranslate = 0.7

      function configureControls() {
        const is2D =
          scene.mode === SceneMode.SCENE2D

        /*
         * In 3D, rotation is handled below by our
         * custom pointer events.
         *
         * In 2D, Cesium handles map translation.
         */
        controller.enableRotate = false
        controller.enableTranslate = is2D
        controller.enableZoom = !morphing
        controller.enableTilt = false
        controller.enableLook = false
      }

      function setHomeView() {
        camera.setView({
          destination:
            Cartesian3.fromDegrees(
              HOME_LONGITUDE,
              HOME_LATITUDE,
              HOME_HEIGHT
            ),

          orientation: {
            heading: 0,

            pitch:
              CesiumMath.toRadians(
                HOME_PITCH
              ),

            roll: 0,
          },
        })
      }

      setHomeView()
      configureControls()
 
      function home() {
        if (disposed || morphing) return
        keepSearchView2D = false
pendingSearchDestination = null  
        replaceCards([])
        camera.cancelFlight()

        if (
          scene.mode === SceneMode.SCENE2D
        ) {
          returningHome = true
          morphing = true

          configureControls()

          scene.morphTo3D(
            MORPH_DURATION
          )

          return
        }

        transitionCooldownUntil =
          performance.now() + 2500

        camera.flyTo({
          destination:
            Cartesian3.fromDegrees(
              HOME_LONGITUDE,
              HOME_LATITUDE,
              HOME_HEIGHT
            ),

          orientation: {
            heading: 0,

            pitch:
              CesiumMath.toRadians(
                HOME_PITCH
              ),

            roll: 0,
          },

          duration: 1.5,
        })
      }

      /*
       * Cesium itself performs the animated
       * morph between 3D and 2D.
       */
      function enter2D() {
        if (
          disposed ||
          morphing ||
          scene.mode !== SceneMode.SCENE3D
        ) {
          return
        }

        morphing = true
        drag = null

        configureControls()

        scene.morphTo2D(
          MORPH_DURATION
        )
      }

      function returnTo3D() {
        if (
          disposed ||
          morphing ||
          scene.mode !== SceneMode.SCENE2D
        ) {
          return
        }

        morphing = true
        drag = null

        configureControls()

        scene.morphTo3D(
          MORPH_DURATION
        )
      }

     const removeMorphComplete =
  scene.morphComplete.addEventListener(
    () => {
      if (disposed) return

      morphing = false

      transitionCooldownUntil =
        performance.now() + 1200

      const is2D =
        scene.mode === SceneMode.SCENE2D

      setMapIs2D(is2D)

      configureControls()

      if (
        is2D &&
        pendingSearchDestination
      ) {
        const destination =
          pendingSearchDestination

        pendingSearchDestination = null

        flyToSearchDestination(destination)

        return
      }

      if (returningHome) {
        returningHome = false
        keepSearchView2D = false
        pendingSearchDestination = null

        camera.flyTo({
          destination:
            Cartesian3.fromDegrees(
              HOME_LONGITUDE,
              HOME_LATITUDE,
              HOME_HEIGHT
            ),

          orientation: {
            heading: 0,

            pitch:
              CesiumMath.toRadians(
                HOME_PITCH
              ),

            roll: 0,
          },

          duration: 1.4,
        })
      }
    }
  )

      const removeModeWatcher =
        scene.postRender.addEventListener(
          () => {
            if (
              disposed ||
              morphing ||
              mode ||
              performance.now() <
                transitionCooldownUntil
            ) {
              return
            }

            const height =
              camera.positionCartographic.height

            if (
              scene.mode ===
                SceneMode.SCENE3D &&
              height < ENTER_2D_HEIGHT
            ) {
              enter2D()
            } else if (
              scene.mode ===
                SceneMode.SCENE2D &&
              !keepSearchView2D &&
              height > RETURN_3D_HEIGHT
            )  {
              returnTo3D()
            }
          }
        )

      /* --------------------------------------------
         Imagery
      -------------------------------------------- */

      void (async () => {
        try {
          const base =
            await TileMapServiceImageryProvider
              .fromUrl(
                '/cesium/Assets/Textures/NaturalEarthII',
                {
                  credit: 'Natural Earth II',
                }
              )

          if (
            !disposed &&
            !viewer.isDestroyed()
          ) {
            viewer.imageryLayers
              .addImageryProvider(base, 0)
          }
        } catch {
          if (!disposed) {
            callbacks.current.onMapError(
              'The local overview imagery could not load.'
            )
          }
        }

        try {
          const imagery =
            await ArcGisMapServerImageryProvider
              .fromUrl(
                'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
                {
                  enablePickFeatures: false,
                }
              )

          if (
            !disposed &&
            !viewer.isDestroyed()
          ) {
            viewer.imageryLayers
              .addImageryProvider(imagery)
          }
        } catch {
          if (!disposed) {
            callbacks.current.onMapError(
              'Satellite imagery is unavailable. The overview layer remains available.'
            )
          }
        }
      })()

      /* --------------------------------------------
         Parcel editing
      -------------------------------------------- */

      const editor =
        new CustomDataSource(
          'parcel-editor'
        )

      void viewer.dataSources.add(editor)

      function notify(
        message: string,
        error = false
      ) {
        callbacks.current.onDrawingChange({
          mode,
          points: vertices.length,
          message,
          error,
        })
      }

      function outline(
        positions: Cartesian3[],
        color: Color
      ) {
        if (positions.length < 2) return

        editor.entities.add({
          polyline: {
            positions,
            width: 2,
            material: color,
            clampToGround: true,
          },
        })
      }

      function marker(
        position: Cartesian3
      ) {
        editor.entities.add({
          position,

          point: {
            pixelSize: 8,
            color: MINT,
            outlineColor: Color.WHITE,
            outlineWidth: 1,
          },
        })
      }

      function drawDraft() {
        editor.entities.removeAll()

        vertices.forEach(marker)

        if (mode === 'polygon') {
          outline(
            [...vertices],
            MINT
          )

          if (vertices.length) {
            editor.entities.add({
              polyline: {
                positions:
                  new CallbackProperty(
                    () => {
                      if (
                        !hover ||
                        !vertices.length
                      ) {
                        return []
                      }

                      return [
                        vertices[
                          vertices.length - 1
                        ],
                        hover,
                      ]
                    },
                    false
                  ),

                width: 2,
                material: GOLD,
                clampToGround: true,
              },
            })
          }
        }

        if (
          mode === 'rectangle' &&
          vertices.length === 1
        ) {
          editor.entities.add({
            polyline: {
              positions:
                new CallbackProperty(
                  () => {
                    if (
                      !hover ||
                      !vertices.length
                    ) {
                      return []
                    }

                    const ring =
                      rectangleCoordinates(
                        vertices[0],
                        hover
                      )

                    return toPositions([
                      ...ring,
                      ring[0],
                    ])
                  },
                  false
                ),

              width: 2,
              material: GOLD,
              clampToGround: true,
            },
          })
        }
      }

      function complete(
        ring: number[][],
        name?: string
      ) {
        try {
          const parcel =
            createParcel(ring, name)

          selected = parcel
          mode = null
          vertices = []
          hover = null

          canvas.style.cursor = 'grab'

          editor.entities.removeAll()

          const positions = toPositions(
            parcel.geometry.coordinates[0]
              .slice(0, -1)
          )

          editor.entities.add({
            polygon: {
              hierarchy:
                new PolygonHierarchy(
                  positions
                ),

              material:
                MINT.withAlpha(0.07),
            },
          })

          outline(
            [
              ...positions,
              positions[0],
            ],
            MINT
          )

          positions.forEach(marker)

          callbacks.current.onParcelSelect(
            parcel
          )

          notify(
            'Area selected. Choose your dates and start the analysis.'
          )
        } catch (cause) {
          notify(
            cause instanceof Error
              ? cause.message
              : 'Invalid selection.',
            true
          )
        }
      }

      function clear() {
        mode = null
        vertices = []
        hover = null
        selected = null
        previousClick = null

        editor.entities.removeAll()

        canvas.style.cursor = 'grab'

        replaceCards([])

        callbacks.current.onParcelSelect(null)

        notify(
          'Draw an area or enter its exact coordinates.'
        )

        configureControls()
      }

      function startDrawing(
        next: DrawMode
      ) {
        if (
          !callbacks.current.interactive ||
          morphing
        ) {
          return
        }

        clear()

        mode = next
        canvas.style.cursor = 'crosshair'

        /*
         * In 2D, drawing needs the left mouse button.
         * Disable Cesium translation until drawing
         * is finished or cancelled.
         */
        controller.enableTranslate = false

        callbacks.current.onActivity()

        notify(
          next === 'rectangle'
            ? 'Click two opposite corners.'
            : 'Click points. Press Enter to finish.'
        )
      }

      function finish() {
        if (mode !== 'polygon') return

        complete(
          toCoordinates(vertices)
        )

        configureControls()
      }

      function undo() {
        if (!mode) return

        vertices.pop()
        hover = null
        previousClick = null

        drawDraft()
        notify('Last point removed.')
      }

      function focusParcel() {
        if (!selected || morphing) return

        const [
          west,
          south,
          east,
          north,
        ] = getBounds(
          selected.geometry.coordinates[0]
        )

        transitionCooldownUntil =
          performance.now() + 2500

        camera.flyTo({
          destination:
            Rectangle.fromDegrees(
              west,
              south,
              east,
              north
            ),

          duration: 1.6,
        })
      }

      function flyToPlace(
  place: Place
) {
  if (
    !callbacks.current.interactive ||
    morphing
  ) {
    return
  }

  clear()

  callbacks.current.onActivity()

  const extent = place.extent

  if (!extent) {
    notify(
      `No geographic bounds are available for ${place.name}. Try another search result.`,
      true
    )

    return
  }

  /*
   * Photon returns:
   * [west, north, east, south]
   */
  const [
    west,
    north,
    east,
    south,
  ] = extent

  const validExtent =
    Number.isFinite(west) &&
    Number.isFinite(south) &&
    Number.isFinite(east) &&
    Number.isFinite(north) &&
    west >= -180 &&
    east <= 180 &&
    south > -90 &&
    north < 90 &&
    west < east &&
    south < north &&
    east - west <= 180

  if (!validExtent) {
    notify(
      `The bounds of ${place.name} cannot be displayed automatically. Try a smaller region.`,
      true
    )

    return
  }

  /*
   * Select the returned bounding rectangle.
   * This is not the exact country border.
   */
  complete(
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
    ],
    `${place.name} bounding rectangle`
  )

  /*
   * Add a small margin around the selected bounds
   * so the country does not touch the screen edges.
   */
  const horizontalPadding =
    Math.max(
      (east - west) * 0.08,
      0.01
    )

  const verticalPadding =
    Math.max(
      (north - south) * 0.08,
      0.01
    )

  const destination =
    Rectangle.fromDegrees(
      Math.max(
        -180,
        west - horizontalPadding
      ),

      Math.max(
        -89.9,
        south - verticalPadding
      ),

      Math.min(
        180,
        east + horizontalPadding
      ),

      Math.min(
        89.9,
        north + verticalPadding
      )
    )

  camera.cancelFlight()

  keepSearchView2D = true

  if (
    scene.mode === SceneMode.SCENE2D
  ) {
    flyToSearchDestination(destination)
    return
  }

  if (
    scene.mode === SceneMode.SCENE3D
  ) {
    pendingSearchDestination =
      destination

    morphing = true
    drag = null

    configureControls()

    scene.morphTo2D(
      MORPH_DURATION
    )

    return
  }

  notify(
    'The map is changing view. Please try again in a moment.',
    true
  )
}

      actions.current = {
        startDrawing,
        finish,
        undo,
        clear,
        home,
        focusParcel,
        flyToPlace,

        selectBounds: (
          [west, south, east, north],
          name
        ) => {
          if (
            !callbacks.current.interactive ||
            morphing
          ) {
            return
          }

          if (
            west >= east ||
            south >= north
          ) {
            notify(
              'West must be smaller than east, and south smaller than north.',
              true
            )

            return
          }

          complete(
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
            ],
            name
          )

          configureControls()

          if (selected) {
            focusParcel()
          }
        },

        inspectRegion: id => {
          const region =
            regionIndex.current.get(id)

          if (!region) return

          openRegion(
            region,
            regionAnchor(region)
          )
        },
      }

      /* --------------------------------------------
         Custom 3D rotation
      -------------------------------------------- */

      function pointerDown(
        event: PointerEvent
      ) {
        if (
          morphing ||
          scene.mode !== SceneMode.SCENE3D ||
          drag ||
          (
            mode &&
            event.button === 0 &&
            !event.shiftKey
          )
        ) {
          return
        }

        camera.cancelFlight()

        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          distance: 0,
        }

        canvas.setPointerCapture(
          event.pointerId
        )

        canvas.style.cursor = 'grabbing'
      }

      function pointerMove(
        event: PointerEvent
      ) {
        if (
          !drag ||
          drag.id !== event.pointerId ||
          scene.mode !== SceneMode.SCENE3D
        ) {
          return
        }

        const dx =
          event.clientX - drag.x

        const dy =
          event.clientY - drag.y

        drag.x = event.clientX
        drag.y = event.clientY

        drag.distance +=
          Math.hypot(dx, dy)

        if (drag.distance < 3) return

        const sensitivity =
          0.8 /
          Math.max(
            canvas.clientWidth,
            canvas.clientHeight
          )

        const up =
          Cartesian3.clone(camera.upWC)

        const right =
          Cartesian3.clone(camera.rightWC)

        camera.rotate(
          up,
          dx * sensitivity
        )

        camera.rotate(
          right,
          dy * sensitivity
        )

        callbacks.current.onActivity()
      }

      function pointerUp(
        event: PointerEvent
      ) {
        if (
          !drag ||
          drag.id !== event.pointerId
        ) {
          return
        }

        if (drag.distance > 4) {
          suppressClickUntil =
            performance.now() + 200
        }

        if (
          canvas.hasPointerCapture(
            event.pointerId
          )
        ) {
          canvas.releasePointerCapture(
            event.pointerId
          )
        }

        drag = null

        canvas.style.cursor =
          mode ? 'crosshair' : 'grab'
      }

      function preventContextMenu(
        event: Event
      ) {
        event.preventDefault()
      }

      canvas.addEventListener(
        'pointerdown',
        pointerDown
      )

      canvas.addEventListener(
        'pointermove',
        pointerMove
      )

      canvas.addEventListener(
        'pointerup',
        pointerUp
      )

      canvas.addEventListener(
        'pointercancel',
        pointerUp
      )

      canvas.addEventListener(
        'contextmenu',
        preventContextMenu
      )

      /* --------------------------------------------
         Cesium click handling
      -------------------------------------------- */

      viewer.screenSpaceEventHandler
        .removeInputAction(
          ScreenSpaceEventType.LEFT_DOUBLE_CLICK
        )

      const handler =
        new ScreenSpaceEventHandler(canvas)

      function click(
        position: Cartesian2
      ) {
        if (
          morphing ||
          performance.now() <
            suppressClickUntil
        ) {
          return
        }

        canvas.focus({
          preventScroll: true,
        })

        if (!mode) {
          if (
            !callbacks.current.showChanges
          ) {
            return
          }

          const pickedObjects =
            scene.drillPick(position)

          for (const picked of pickedObjects) {
            if (
              !(picked.id instanceof Entity)
            ) {
              continue
            }

            const region =
              regionIndex.current.get(
                String(picked.id.id)
              )

            if (!region) continue

            openRegion(
              region,
              regionAnchor(region)
            )

            return
          }

          return
        }

        if (
          !callbacks.current.interactive
        ) {
          return
        }

        const world =
          camera.pickEllipsoid(
            position,
            scene.globe.ellipsoid
          )

        if (!world) {
          notify(
            'Click on the visible Earth.',
            true
          )

          return
        }

        const now = performance.now()

        if (
          previousClick &&
          now - previousClickTime < 400 &&
          Cartesian2.distance(
            previousClick,
            position
          ) < 6
        ) {
          return
        }

        previousClick =
          Cartesian2.clone(position)

        previousClickTime = now

        if (
          mode === 'rectangle' &&
          vertices.length === 1
        ) {
          complete(
            rectangleCoordinates(
              vertices[0],
              world
            )
          )

          configureControls()
          return
        }

        vertices.push(world)
        drawDraft()

        notify(
          `${vertices.length} point${
            vertices.length === 1 ? '' : 's'
          } placed.`
        )
      }

      handler.setInputAction(
        (
          event: {
            position: Cartesian2
          }
        ) => {
          click(event.position)
        },
        ScreenSpaceEventType.LEFT_CLICK
      )

      handler.setInputAction(
        (
          event: {
            position: Cartesian2
          }
        ) => {
          if (mode !== 'polygon') return

          click(event.position)
          finish()
        },
        ScreenSpaceEventType.LEFT_DOUBLE_CLICK
      )

      handler.setInputAction(
        (
          event: {
            endPosition: Cartesian2
          }
        ) => {
          if (!mode || morphing) return

          hover =
            camera.pickEllipsoid(
              event.endPosition,
              scene.globe.ellipsoid
            ) ?? null
        },
        ScreenSpaceEventType.MOUSE_MOVE
      )

      function keyDown(
        event: KeyboardEvent
      ) {
        const target = event.target

        if (
          target instanceof HTMLElement &&
          target.closest(
            'input,textarea,select,button,[contenteditable="true"]'
          )
        ) {
          return
        }

        if (event.key === 'Escape') {
          event.preventDefault()

          if (mode) {
            clear()
          } else {
            replaceCards([])
          }

          return
        }

        if (
          mode &&
          event.key === 'Enter'
        ) {
          event.preventDefault()
          finish()
          return
        }

        if (
          mode &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'z'
        ) {
          event.preventDefault()
          undo()
        }
      }

      canvas.addEventListener(
        'keydown',
        keyDown
      )

      /* --------------------------------------------
         Result cards and leader lines
      -------------------------------------------- */

      const occluder =
        new EllipsoidalOccluder(
          scene.globe.ellipsoid,
          camera.positionWC
        )

      const removeCardRenderer =
        scene.postRender.addEventListener(
          () => {
            if (disposed) return

            const is3D =
              scene.mode ===
              SceneMode.SCENE3D

            if (is3D) {
              occluder.cameraPosition =
                camera.positionWC
            }

            for (
              const card of cardsRef.current
            ) {
              const id = card.region.id

              const element =
                cardElements.current.get(id)

              const line =
                lineElements.current.get(id)

              const anchor =
                anchorElements.current.get(id)

              if (
                !element ||
                !line ||
                !anchor
              ) {
                continue
              }

              const position =
                SceneTransforms
                  .worldToWindowCoordinates(
                    scene,
                    card.anchor
                  )

              const visible =
                !morphing &&
                callbacks.current.showChanges &&
                Boolean(position) &&
                (
                  !is3D ||
                  occluder.isPointVisible(
                    card.anchor
                  )
                ) &&
                position!.x >= 0 &&
                position!.x <= canvas.clientWidth &&
                position!.y >= 0 &&
                position!.y <= canvas.clientHeight

              element.style.visibility =
                visible ? 'visible' : 'hidden'

              line.style.visibility =
                visible ? 'visible' : 'hidden'

              anchor.style.visibility =
                visible ? 'visible' : 'hidden'

              if (!visible || !position) {
                continue
              }

              const cardRect =
                element.getBoundingClientRect()

              const canvasRect =
                canvas.getBoundingClientRect()

              const endX =
                cardRect.left -
                canvasRect.left +
                cardRect.width / 2

              const endY =
                cardRect.bottom -
                canvasRect.top

              const middleY =
                endY +
                (position.y - endY) * 0.45

              line.setAttribute(
                'd',
                `M ${position.x} ${position.y}
                 C ${position.x} ${middleY},
                   ${endX} ${middleY},
                   ${endX} ${endY}`
              )

              anchor.setAttribute(
                'cx',
                String(position.x)
              )

              anchor.setAttribute(
                'cy',
                String(position.y)
              )
            }
          }
        )

      /* --------------------------------------------
         Cleanup
      -------------------------------------------- */

      return () => {
        disposed = true

        handler.destroy()

        removeMorphComplete()
        removeModeWatcher()
        removeCardRenderer()

        canvas.removeEventListener(
          'pointerdown',
          pointerDown
        )

        canvas.removeEventListener(
          'pointermove',
          pointerMove
        )

        canvas.removeEventListener(
          'pointerup',
          pointerUp
        )

        canvas.removeEventListener(
          'pointercancel',
          pointerUp
        )

        canvas.removeEventListener(
          'contextmenu',
          preventContextMenu
        )

        canvas.removeEventListener(
          'keydown',
          keyDown
        )

        actions.current = null
        viewerRef.current = null
        layerRef.current = null

        if (!viewer.isDestroyed()) {
          viewer.destroy()
        }
      }
    }, [openRegion, replaceCards])

    /* ----------------------------------------------
       Result geometry
    ---------------------------------------------- */

    useEffect(() => {
      const viewer = viewerRef.current

      if (
        !viewer ||
        viewer.isDestroyed()
      ) {
        return
      }

      regionIndex.current = new Map(
        props.report?.features.features.map(
          region => [
            region.id,
            region,
          ]
        ) ?? []
      )

      if (!props.report) {
        queueMicrotask(() => {
          replaceCards([])
        })

        return
      }

      const source =
        new CustomDataSource(
          'detected-surface-changes'
        )

      source.show =
        callbacks.current.showChanges

      layerRef.current = source

      for (
        const region of
        props.report.features.features
      ) {
        const [outer, ...holes] =
          region.geometry.coordinates

        if (!outer?.length) continue

        const first = outer[0]

        source.entities.add({
          id: region.id

          ,

          position:
            Cartesian3.fromDegrees(
              first[0],
              first[1]
            ),

          polygon: {
            hierarchy:
              new PolygonHierarchy(
                toPositions(outer),

                holes.map(hole =>
                  new PolygonHierarchy(
                    toPositions(hole)
                  )
                )
              ),

            material:
              RED.withAlpha(0.6),
          },

          point: {
            pixelSize: 9,
            color: RED,
            outlineColor: Color.WHITE,
            outlineWidth: 1.5,
          },
        })
      }

      let cancelled = false

      void viewer.dataSources.add(source)
        .then(() => {
          if (
            cancelled &&
            !viewer.isDestroyed()
          ) {
            viewer.dataSources.remove(
              source,
              true
            )
          }
        })
        .catch(() => {
          if (!cancelled) {
            callbacks.current.onMapError(
              'The result layer could not be displayed.'
            )
          }
        })

      return () => {
        cancelled = true

        if (
          layerRef.current === source
        ) {
          layerRef.current = null
        }

        if (!viewer.isDestroyed()) {
          viewer.dataSources.remove(
            source,
            true
          )
        }
      }
    }, [props.report, replaceCards])

    useEffect(() => {
      if (layerRef.current) {
        layerRef.current.show =
          props.showChanges
      }
    }, [props.showChanges])

    /* ----------------------------------------------
       Interface
    ---------------------------------------------- */

    return (
      <div className="globe-stage">
        <div
          ref={container}
          className="globe-canvas"
          aria-label="Interactive Earth. Drag to rotate and scroll to zoom."
        />

        <div
          className={`map-grid ${
            mapIs2D
              ? 'map-grid--visible'
              : ''
          }`}
          aria-hidden="true"
        />

        <div className="callouts">
          <svg
            className="callout-lines"
            aria-hidden="true"
          >
            {cards.map(card => (
              <g key={card.region.id}>
                <path
                  ref={element => {
                    if (element) {
                      lineElements.current.set(
                        card.region.id,
                        element
                      )
                    } else {
                      lineElements.current.delete(
                        card.region.id
                      )
                    }
                  }}
                  className="callout-line"
                  pathLength="1"
                />

                <circle
                  ref={element => {
                    if (element) {
                      anchorElements.current.set(
                        card.region.id,
                        element
                      )
                    } else {
                      anchorElements.current.delete(
                        card.region.id
                      )
                    }
                  }}
                  className="callout-anchor"
                  r="5"
                />
              </g>
            ))}
          </svg>

          {cards.map((card, index) => (
            <article
              key={card.region.id}
              ref={element => {
                if (element) {
                  cardElements.current.set(
                    card.region.id,
                    element
                  )
                } else {
                  cardElements.current.delete(
                    card.region.id
                  )
                }
              }}
              className={`change-callout change-callout--${index}`}
              aria-label="Detected surface change details"
            >
              <div
                className="callout-heading callout-drag-handle"
                onPointerDown={event => {
                  if (event.button !== 0 || (event.target as Element).closest('button')) return
                  const element = event.currentTarget.parentElement
                  if (!element) return
                  const rect = element.getBoundingClientRect()
                  cardDrag.current = {
                    id: card.region.id,
                    pointerId: event.pointerId,
                    offsetX: event.clientX - rect.left,
                    offsetY: event.clientY - rect.top,
                  }
                  cardElements.current.forEach(other => { other.style.zIndex = '2' })
                  element.style.zIndex = '3'
                  element.classList.add('change-callout--dragging')
                  event.currentTarget.setPointerCapture(event.pointerId)
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onPointerMove={event => {
                  const drag = cardDrag.current
                  if (!drag || drag.id !== card.region.id || drag.pointerId !== event.pointerId) return
                  const element = event.currentTarget.parentElement
                  const container = element?.parentElement
                  if (!element || !container) return
                  const bounds = container.getBoundingClientRect()
                  const maxLeft = Math.max(0, bounds.width - element.offsetWidth)
                  const maxTop = Math.max(0, bounds.height - element.offsetHeight)
                  element.style.left = `${Math.min(maxLeft, Math.max(0, event.clientX - bounds.left - drag.offsetX))}px`
                  element.style.top = `${Math.min(maxTop, Math.max(0, event.clientY - bounds.top - drag.offsetY))}px`
                  element.style.right = 'auto'
                  event.stopPropagation()
                }}
                onPointerUp={event => {
                  if (cardDrag.current?.pointerId !== event.pointerId) return
                  cardDrag.current = null
                  event.currentTarget.parentElement?.classList.remove('change-callout--dragging')
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                  event.stopPropagation()
                }}
                onLostPointerCapture={event => {
                  if (cardDrag.current?.pointerId === event.pointerId) cardDrag.current = null
                  event.currentTarget.parentElement?.classList.remove('change-callout--dragging')
                }}
              >
                <span className="eyebrow">
                  OBSERVATION / {index + 1}
                </span>

                <button
                  type="button"
                  aria-label="Close change details"
                  onClick={() => {
                    replaceCards(
                      cardsRef.current.filter(
                        item =>
                          item.region.id !==
                          card.region.id
                      )
                    )
                  }}
                >
                  &times;
                </button>
              </div>

              <h2>
                Surface change detected
              </h2>

              <p className="callout-description">
                Radar observations indicate
                a change in this region.
              </p>

              <div className="callout-area">
                {card.region.properties.area_km2
                  .toLocaleString('en-US', {
                    maximumFractionDigits: 3,
                  })}

                <span>km²</span>
              </div>

              <span className="metric-caption">
                Estimated mapped footprint
              </span>

              <dl className="callout-dates">
                <div>
                  <dt>First observation</dt>

                  <dd>
                    {card.region.properties.from}
                  </dd>
                </div>

                <div>
                  <dt>Last observation</dt>

                  <dd>
                    {card.region.properties.to}
                  </dd>
                </div>
              </dl>

              <p className="callout-note">
                Climate cause and change category
                have not been established.
              </p>
            </article>
          ))}
        </div>
      </div>
    )
  }
)

export default Globe
