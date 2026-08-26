import type maplibregl from 'maplibre-gl';

/**
 * Tears down layers and their source, tolerating an already-removed map.
 *
 * MapLibre exposes no public way to ask whether `remove()` has been called, and
 * afterwards every `getLayer` call throws on an undefined internal style. Layer
 * components can unmount in that window — during a reload, or when the map errors
 * out — and an exception there takes the whole React tree down with it.
 */
export function removeLayers(
  map: maplibregl.Map,
  layerIds: string[],
  sourceId?: string,
): void {
  try {
    if (!map.getStyle()) return;
    for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
    if (sourceId && map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    // The map is already gone; nothing left to clean up.
  }
}
