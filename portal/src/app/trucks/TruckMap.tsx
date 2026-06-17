"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";

export type TruckPoint = {
  name: string;
  lat: number;
  lng: number;
  city?: string;
};

// Sane fallback if no truck data is provided.
const DEFAULT_CENTER: [number, number] = [39.8283, -98.5795];
const DEFAULT_ZOOM = 4;

// Inline-SVG marker — a circular badge with the Lucide `truck` glyph. Drawn
// via L.divIcon so we sidestep Leaflet's default-icon asset-path issues with
// bundlers entirely.
const TRUCK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
  'stroke="#fff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>' +
  '<path d="M15 18H9"/>' +
  '<path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>' +
  '<circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';

const truckIcon = L.divIcon({
  className: "",
  html:
    '<div style="width:28px;height:28px;border-radius:50%;' +
    "background:#3b82f6;border:2px solid #fff;display:flex;" +
    "align-items:center;justify-content:center;" +
    'box-shadow:0 0 8px rgba(59,130,246,0.85);">' +
    TRUCK_SVG +
    "</div>",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

// Compute the bbox of the truck set, jump the map to the "fit" zoom minus
// one (i.e. one level wider than the tightest fit) so there's headroom
// around the cluster.
function FitToTrucks({ trucks }: { trucks: TruckPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (trucks.length === 0) return;
    const points: [number, number][] = trucks.map((t) => [t.lat, t.lng]);
    const bounds = L.latLngBounds(points);
    if (!bounds.isValid()) return;
    // Tightest zoom that still fits the cluster (with a little padding).
    const fitZoom = map.getBoundsZoom(bounds, false, L.point(40, 40));
    map.setView(bounds.getCenter(), Math.max(2, fitZoom), { animate: false });
  }, [trucks, map]);
  return null;
}

export default function TruckMap({
  trucks = [],
}: {
  trucks?: TruckPoint[];
}) {
  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      scrollWheelZoom={false}
      zoomControl={false}
      attributionControl={false}
      className="h-full w-full bg-zinc-900"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      {trucks.map((t) => (
        <Marker key={t.name} position={[t.lat, t.lng]} icon={truckIcon}>
          <Tooltip direction="top" offset={[0, -8]}>
            <span className="font-mono text-xs">
              {t.name}
              {t.city ? ` — ${t.city}` : ""}
            </span>
          </Tooltip>
        </Marker>
      ))}
      <FitToTrucks trucks={trucks} />
    </MapContainer>
  );
}
