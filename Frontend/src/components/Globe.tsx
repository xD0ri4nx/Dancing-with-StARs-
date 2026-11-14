
import { useEffect, useRef } from 'react'
import {
  Viewer,
  Cartesian3,
  Color,
  ArcGisMapServerImageryProvider,
} from 'cesium'

import 'cesium/Build/Cesium/Widgets/widgets.css'

export default function Globe() {
  const containerRef = useRef<HTMLDivElement>(null)

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
    })

    // Claritatea randarii
    viewer.resolutionScale = 1.5

    // Aspectul globului
    viewer.scene.globe.show = true
    viewer.scene.globe.baseColor =
      Color.fromCssColorString('#285d91')

    viewer.scene.backgroundColor = Color.BLACK

    // Camera porneste deasupra Romaniei
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(
        24.9,
        45.9,
        12000000
      ),
    })

    // Imagini satelitare ArcGIS World Imagery
    async function loadMap() {
      try {
        const provider =
          await ArcGisMapServerImageryProvider.fromUrl(
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
          )

        if (disposed || viewer.isDestroyed()) return

        viewer.imageryLayers.addImageryProvider(provider)

        console.log('Satellite imagery loaded successfully')
      } catch (error) {
        if (!disposed) {
          console.error(
            'Satellite imagery loading failed:',
            error
          )
        }
      }
    }

    // Apelam o singura data
    void loadMap()

    viewer.scene.renderError.addEventListener(
      (_scene, error) => {
        console.error('Cesium rendering error:', error)
      }
    )

    return () => {
      disposed = true

      if (!viewer.isDestroyed()) {
        viewer.destroy()
      }
    }
  }, [])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
      }}
    />
  )
}
