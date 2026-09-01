package geo

import "encoding/json"

// SimplifyFeatureCollection simplifies every LineString and MultiLineString in a
// raw GeoJSON FeatureCollection, leaving all other geometry and every property
// untouched.
//
// This mirrors what useRoadShape.ts does on the client today. Moving it here
// means the phone receives geometry that is already cheap to draw instead of
// spending CPU on 374 KB of coordinates it will immediately throw away.
//
// Unrecognised structure is passed through rather than rejected: the goal is a
// smaller payload, and an unfamiliar shape is better served verbatim than
// dropped.
func SimplifyFeatureCollection(raw json.RawMessage, epsilon float64) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return raw, nil
	}

	var collection struct {
		Features []json.RawMessage `json:"features"`
	}
	if err := json.Unmarshal(raw, &collection); err != nil {
		return raw, err
	}
	if len(collection.Features) == 0 {
		return raw, nil
	}

	// Decode into a generic map so unknown top-level members survive.
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return raw, err
	}

	simplified := make([]json.RawMessage, 0, len(collection.Features))
	for _, feature := range collection.Features {
		out, err := simplifyFeature(feature, epsilon)
		if err != nil {
			return raw, err
		}
		simplified = append(simplified, out)
	}

	encoded, err := json.Marshal(simplified)
	if err != nil {
		return raw, err
	}
	envelope["features"] = encoded
	return json.Marshal(envelope)
}

func simplifyFeature(raw json.RawMessage, epsilon float64) (json.RawMessage, error) {
	var feature map[string]json.RawMessage
	if err := json.Unmarshal(raw, &feature); err != nil {
		return raw, err
	}
	geometryRaw, ok := feature["geometry"]
	if !ok {
		return raw, nil
	}

	var geometry map[string]json.RawMessage
	if err := json.Unmarshal(geometryRaw, &geometry); err != nil {
		return raw, nil
	}
	var kind string
	if err := json.Unmarshal(geometry["type"], &kind); err != nil {
		return raw, nil
	}

	switch kind {
	case "LineString":
		var line []Point
		if err := json.Unmarshal(geometry["coordinates"], &line); err != nil {
			return raw, nil
		}
		encoded, err := json.Marshal(SimplifyLine(line, epsilon))
		if err != nil {
			return raw, err
		}
		geometry["coordinates"] = encoded
	case "MultiLineString":
		var lines [][]Point
		if err := json.Unmarshal(geometry["coordinates"], &lines); err != nil {
			return raw, nil
		}
		out := make([][]Point, 0, len(lines))
		for _, line := range lines {
			out = append(out, SimplifyLine(line, epsilon))
		}
		encoded, err := json.Marshal(out)
		if err != nil {
			return raw, err
		}
		geometry["coordinates"] = encoded
	default:
		return raw, nil
	}

	encodedGeometry, err := json.Marshal(geometry)
	if err != nil {
		return raw, err
	}
	feature["geometry"] = encodedGeometry
	return json.Marshal(feature)
}

// Polylines flattens every LineString and MultiLineString in a FeatureCollection
// into a flat list of [lng, lat] lines, for snapping. Mirrors polylinesOf in
// src/lib/transit/snapToRoute.ts.
func Polylines(raw json.RawMessage) [][]Point {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var collection struct {
		Features []struct {
			Geometry struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(raw, &collection); err != nil {
		return nil
	}

	var out [][]Point
	for _, feature := range collection.Features {
		switch feature.Geometry.Type {
		case "LineString":
			var line []Point
			if err := json.Unmarshal(feature.Geometry.Coordinates, &line); err == nil && len(line) >= 2 {
				out = append(out, line)
			}
		case "MultiLineString":
			var lines [][]Point
			if err := json.Unmarshal(feature.Geometry.Coordinates, &lines); err == nil {
				for _, line := range lines {
					if len(line) >= 2 {
						out = append(out, line)
					}
				}
			}
		}
	}
	return out
}
