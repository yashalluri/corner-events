// NYC neighborhood assignment from coordinates — nearest-centroid over a
// curated list. Deterministic, offline, and free: live Places lookups don't
// return neighborhoods without extra field costs, and this is plenty accurate
// at map-pin granularity.

interface Hood {
  name: string;
  lat: number;
  lng: number;
}

const HOODS: Hood[] = [
  // Manhattan
  { name: 'Financial District', lat: 40.7075, lng: -74.0089 },
  { name: 'Tribeca', lat: 40.7163, lng: -74.0086 },
  { name: 'Chinatown', lat: 40.7158, lng: -73.997 },
  { name: 'Lower East Side', lat: 40.7185, lng: -73.986 },
  { name: 'SoHo', lat: 40.7233, lng: -74.003 },
  { name: 'Nolita', lat: 40.7226, lng: -73.9955 },
  { name: 'Greenwich Village', lat: 40.7336, lng: -74.0027 },
  { name: 'West Village', lat: 40.7358, lng: -74.0036 },
  { name: 'East Village', lat: 40.7265, lng: -73.9815 },
  { name: 'Gramercy', lat: 40.7368, lng: -73.9845 },
  { name: 'Chelsea', lat: 40.7465, lng: -74.0014 },
  { name: 'Flatiron', lat: 40.7411, lng: -73.9897 },
  { name: 'Koreatown', lat: 40.7478, lng: -73.9869 },
  { name: 'Hudson Yards', lat: 40.7539, lng: -74.0004 },
  { name: 'Midtown', lat: 40.7549, lng: -73.984 },
  { name: 'Hell’s Kitchen', lat: 40.7638, lng: -73.9918 },
  { name: 'Upper East Side', lat: 40.7736, lng: -73.9566 },
  { name: 'Upper West Side', lat: 40.787, lng: -73.9754 },
  { name: 'Harlem', lat: 40.8116, lng: -73.9465 },
  // Brooklyn
  { name: 'Dumbo', lat: 40.7033, lng: -73.9881 },
  { name: 'Brooklyn Heights', lat: 40.696, lng: -73.9936 },
  { name: 'Downtown Brooklyn', lat: 40.6928, lng: -73.9854 },
  { name: 'Fort Greene', lat: 40.6892, lng: -73.9742 },
  { name: 'Williamsburg', lat: 40.7143, lng: -73.9535 },
  { name: 'Greenpoint', lat: 40.7304, lng: -73.9515 },
  { name: 'Bushwick', lat: 40.6944, lng: -73.9213 },
  { name: 'Bed-Stuy', lat: 40.6872, lng: -73.9418 },
  { name: 'Clinton Hill', lat: 40.6897, lng: -73.9654 },
  { name: 'Park Slope', lat: 40.6715, lng: -73.9805 },
  { name: 'Gowanus', lat: 40.6785, lng: -73.9887 },
  { name: 'Carroll Gardens', lat: 40.6795, lng: -73.9993 },
  { name: 'Red Hook', lat: 40.6748, lng: -74.0114 },
  { name: 'Crown Heights', lat: 40.6694, lng: -73.9422 },
  { name: 'Prospect Heights', lat: 40.6774, lng: -73.9668 },
  { name: 'Ridgewood', lat: 40.7043, lng: -73.9018 },
  // Queens
  { name: 'Long Island City', lat: 40.7447, lng: -73.9485 },
  { name: 'Astoria', lat: 40.7644, lng: -73.9235 },
  { name: 'Flushing', lat: 40.7675, lng: -73.8331 },
];

const MAX_KM = 3.5; // beyond this, don't pretend we know the neighborhood

/** Equirectangular km distance — accurate to well under 1% at NYC scale. */
export function kmBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return Math.hypot((lat1 - lat2) * 111, (lng1 - lng2) * 111 * Math.cos((lat1 * Math.PI) / 180));
}

export function neighborhoodFor(lat: number, lng: number): string | null {
  let best: string | null = null;
  let bestKm = Infinity;
  for (const h of HOODS) {
    const km = kmBetween(lat, lng, h.lat, h.lng);
    if (km < bestKm) {
      bestKm = km;
      best = h.name;
    }
  }
  return bestKm <= MAX_KM ? best : null;
}
