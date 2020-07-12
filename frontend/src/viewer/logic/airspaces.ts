import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const TILE_SIZE = 256;
const RESTRICTED_COLOR = '#bfbf40';

type Point = { x: number; y: number };
type Polygon = Point[];

// id -> layer
const layerMap = new Map();

// Returns html describing airspaces at the given point.
// altitude is expressed in meters.
export function AspAt(
  map: google.maps.Map,
  latLng: google.maps.LatLng,
  altitude: number,
  includeRestricted: boolean,
): string | null {
  const worldCoords = (map.getProjection() as google.maps.Projection).fromLatLngToPoint(latLng);
  const zoom = Math.min(map.getZoom(), 13);
  const scale = 1 << zoom;

  const tileCoords = new google.maps.Point(
    Math.floor((worldCoords.x * scale) / TILE_SIZE),
    Math.floor((worldCoords.y * scale) / TILE_SIZE),
  );

  const id = tileId(zoom, tileCoords.x, tileCoords.y);

  if (!layerMap.has(id)) {
    return null;
  }

  const pxCoords = new google.maps.Point(
    Math.floor(worldCoords.x * scale) - tileCoords.x * TILE_SIZE,
    Math.floor(worldCoords.y * scale) - tileCoords.y * TILE_SIZE,
  );

  const layer = layerMap.get(id);

  const info = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (
      f.properties.bottom_km < altitude / 1000 &&
      !(f.properties.color == RESTRICTED_COLOR && !includeRestricted) &&
      isInFeature(pxCoords, f)
    ) {
      info.push(
        `<b>[${f.properties.category}] ${f.properties.name}</b><br/>↧${f.properties.bottom} ↥${f.properties.top}`,
      );
      if (info.length == 5) {
        break;
      }
    }
  }

  return info.join('<br/>');
}

// Returns whether the point is inside the polygon feature.
function isInFeature(point: google.maps.Point, feature: any): boolean {
  const ratio = 256 / feature.extent;
  const polygons = classifyRings(feature.loadGeometry());
  for (const rings of polygons) {
    // The point must be in the outer ring.
    let isIn = isInPolygon(point, rings[0], ratio);
    if (isIn) {
      for (let i = 1; i < rings.length; ++i) {
        // The point must not be in any hole.
        isIn = isIn && !isInPolygon(point, rings[i], ratio);
      }
    }
    if (isIn) {
      return true;
    }
  }

  return false;
}

// Returns whether the point is in the polygon.
function isInPolygon(point: google.maps.Point, polygon: { x: number; y: number }[], ratio: number): boolean {
  const { x, y } = { x: point.x / ratio, y: point.y / ratio };

  let isIn = false;

  let [xa, ya] = [polygon[0].x, polygon[0].y];
  for (let j = 1; j < polygon.length; j++) {
    const [xb, yb] = [polygon[j].x, polygon[j].y];

    if (ya > y != yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) {
      isIn = !isIn;
    }
    [xa, ya] = [xb, yb];
  }

  return isIn;
}

// Airspaces MapType.
// altitude is expressed in meters.
export class AspMapType {
  altitude = 1000;
  minZoom = 0;
  maxZoom = 0;
  tileSize: google.maps.Size;
  showRestricted = true;

  constructor(altitude: number, maxZoom: number) {
    this.altitude = altitude || 1000;
    this.minZoom = 4;
    this.maxZoom = maxZoom;
    this.tileSize = new google.maps.Size(TILE_SIZE, TILE_SIZE);
    layerMap.clear();
  }

  getTile(coord: google.maps.Point, zoom: number, doc: HTMLDocument): HTMLElement {
    return getTile(coord, zoom, doc, this.altitude, this.showRestricted);
  }

  releaseTile(canvas: HTMLElement): void {
    const id = Number(canvas.getAttribute('tile-id'));
    layerMap.delete(id);
  }

  setAltitude(altitude: number): void {
    this.altitude = altitude;
  }

  setShowRestricted(show: boolean): void {
    this.showRestricted = show;
  }
}

// Airspaces Map Type used when tiles are not available at the current zoom level.
// Tiles from a lower level are over zoomed.
// altitude is expressed in meters.
export class AspZoomMapType extends AspMapType {
  baseZoom = 0;

  constructor(altitude: number, baseZoom: number, zoom: number) {
    super(altitude, zoom);
    this.minZoom = zoom;
    this.baseZoom = baseZoom;
    const overZoom = zoom - baseZoom;
    this.tileSize = new google.maps.Size(TILE_SIZE << overZoom, TILE_SIZE << overZoom);
  }

  getTile(coord: google.maps.Point, zoom: number, doc: HTMLDocument): HTMLElement {
    return getTile(coord, this.baseZoom, doc, this.altitude, this.showRestricted, this.minZoom);
  }
}

// Fetch a vector tile and returns a canvas.
// altitude is expressed in meters.
function getTile(
  coord: google.maps.Point,
  baseZoom: number,
  doc: HTMLDocument,
  altitude: number,
  showRestricted: boolean,
  dstZoom: number = baseZoom,
): HTMLElement {
  const canvas = doc.createElement('canvas');
  const overZoom = dstZoom - baseZoom;

  const id = tileId(baseZoom, coord.x, coord.y);
  canvas.setAttribute('tile-id', `${id}`);

  fetch(`https://airspaces.storage.googleapis.com/tiles/${baseZoom}/${coord.x}/${coord.y}.pbf`)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buffer) => {
      if (buffer == null) {
        return;
      }

      const vTile = new VectorTile(new Protobuf(buffer));

      if (vTile.layers.asp) {
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        canvas.height = canvas.width = TILE_SIZE << overZoom;
        canvas.style.imageRendering = 'pixelated';

        if (devicePixelRatio == 2) {
          canvas.style.width = `${canvas.width}px`;
          canvas.style.height = `${canvas.height}px`;
          canvas.width *= 2;
          canvas.height *= 2;
          ctx.scale(2, 2);
        }

        layerMap.set(id, vTile.layers.asp);

        for (let i = 0; i < vTile.layers.asp.length; i++) {
          const f = vTile.layers.asp.feature(i);
          const ratio = (TILE_SIZE << overZoom) / f.extent;
          if (
            f.type === 3 &&
            f.properties.bottom_km < altitude / 1000 &&
            !(f.properties.color == RESTRICTED_COLOR && !showRestricted)
          ) {
            const polygons = classifyRings(f.loadGeometry());
            polygons.forEach((polygon) => {
              ctx.beginPath();
              polygon.forEach((ring: Point[]) => {
                const coords = ring.map(({ x, y }: { x: number; y: number }) => ({
                  x: Math.round(x * ratio),
                  y: Math.round(y * ratio),
                }));
                ctx.fillStyle = f.properties.color + '70';
                ctx.moveTo(coords[0].x, coords[0].y);
                for (let j = 1; j < coords.length; j++) {
                  const p = coords[j];
                  ctx.lineTo(p.x, p.y);
                }
              });
              ctx.closePath();
              ctx.fill('evenodd');
              ctx.strokeStyle = f.properties.color + '75';
              ctx.stroke();
            });
          }
        }
      }
    });

  return canvas;
}

//

function tileId(z: number, x: number, y: number): number {
  return ((1 << z) * y + x) * 32 + z;
}

// Code adapted from https://github.com/mapbox/vector-tile-js

// Returns an array of polygons.
// Each polygon is an array ring.
// The first ring in this array is the outer ring. Following rings are holes.
function classifyRings(rings: Point[][]): Polygon[][] {
  const len = rings.length;

  if (len <= 1) {
    return [rings];
  }

  const polygons: Polygon[][] = [];
  let polygon: Polygon[] | null = null;
  let ccw: boolean | null = null;

  for (let i = 0; i < len; i++) {
    const area = signedArea(rings[i]);
    if (area === 0) {
      continue;
    }

    if (ccw == null) {
      ccw = area < 0;
    }

    if (ccw === area < 0) {
      // Create a new polygon when the winding is the same as the first polygon.
      if (polygon) {
        polygons.push(polygon);
      }
      polygon = [rings[i]];
    } else {
      // Pushes holes in the current polygon.
      polygon?.push(rings[i]);
    }
  }
  if (polygon) {
    polygons.push(polygon);
  }

  return polygons;
}

// Computes the area of a polygon.
// See https://en.wikipedia.org/wiki/Shoelace_formula.
function signedArea(polygon: Polygon): number {
  let sum = 0;
  const len = polygon.length;
  for (let i = 0, j = len - 1; i < len; j = i++) {
    const p1 = polygon[i];
    const p2 = polygon[j];
    sum += (p2.x - p1.x) * (p1.y + p2.y);
  }
  return sum;
}
