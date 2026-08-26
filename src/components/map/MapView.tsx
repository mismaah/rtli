import { useEffect, useRef, useState, type ReactNode } from 'react';
import maplibregl from 'maplibre-gl';
import { MapContext } from './MapContext';

/**
 * OpenFreeMap: free vector basemap, no API key and no usage limits.
 * Vector tiles cost far less mobile data than the raster tiles rtl.mv serves.
 *
 * "fiord" rather than the default "liberty" so the basemap sits behind the app's
 * dark chrome instead of glaring against it, and so the bright route colours RTL
 * assigns each route stay the most prominent thing on screen. The plain "dark"
 * style renders Malé near black-on-black and the islands disappear.
 */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/fiord';

const MALE_CENTER: [number, number] = [73.5093, 4.1755];

interface Props {
  children?: ReactNode;
  className?: string;
}

export function MapView({ children, className }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!container.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      center: MALE_CENTER,
      zoom: 12.5,
      attributionControl: { compact: true },
      // Rotation is more of a hazard than a help on a one-handed transit map.
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    });
    instance.touchZoomRotate.disableRotation();

    instance.on('load', () => setMap(instance));

    // Markers glide between position updates, but that same transition would
    // leave them trailing behind the basemap while it is panned or zoomed, so
    // the CSS turns it off for as long as the map is moving.
    const startMove = () => instance.getContainer().classList.add('rtl-map-moving');
    const endMove = () => instance.getContainer().classList.remove('rtl-map-moving');
    instance.on('movestart', startMove);
    instance.on('moveend', endMove);

    return () => {
      instance.off('movestart', startMove);
      instance.off('moveend', endMove);
      instance.remove();
      setMap(null);
    };
  }, []);

  // The map element gets its own div: MapLibre's stylesheet forces
  // `position: relative` on `.maplibregl-map`, which would silently override any
  // positioning utility placed on the same element and collapse it to zero height.
  return (
    <div className={className}>
      <div ref={container} className="size-full" />
      {map ? <MapContext.Provider value={map}>{children}</MapContext.Provider> : null}
    </div>
  );
}
