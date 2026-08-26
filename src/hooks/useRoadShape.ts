import { useQuery } from '@tanstack/react-query';
import { fetchRoadShape } from '@/api/rtl';
import { simplifyLine } from '@/lib/geo';

/**
 * Route geometry, simplified before it reaches the map.
 *
 * R2 alone is 374 KB of raw coordinates; at the zooms this app uses the detail
 * is invisible, so Douglas–Peucker keeps rendering and storage cheap on mobile.
 */
export function useRoadShape(routeCode: string | null) {
  return useQuery<GeoJSON.FeatureCollection | null>({
    queryKey: ['rtl', 'roadshape', routeCode],
    queryFn: async ({ signal }) => {
      const res = await fetchRoadShape(routeCode!, signal);
      const shape = res.roadShape;
      if (!shape) return null;
      return {
        ...shape,
        features: shape.features.map((feature) => {
          const geometry = feature.geometry;
          if (geometry.type === 'MultiLineString') {
            return {
              ...feature,
              geometry: {
                ...geometry,
                coordinates: geometry.coordinates.map((line) =>
                  simplifyLine(line as [number, number][]),
                ),
              },
            };
          }
          if (geometry.type === 'LineString') {
            return {
              ...feature,
              geometry: {
                ...geometry,
                coordinates: simplifyLine(geometry.coordinates as [number, number][]),
              },
            };
          }
          return feature;
        }),
      };
    },
    enabled: Boolean(routeCode),
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
  });
}
