import type { DeviceInfo, GroupInfo } from './wire.js';

/**
 * Deterministic demo fleet. All shipments, products, dose counts and values are
 * SIMULATED for demonstration. Product names are generic categories, not brands.
 */
export const CITIES: Record<string, { lat: number; lon: number }> = {
  Bengaluru: { lat: 12.97, lon: 77.59 },
  Hyderabad: { lat: 17.39, lon: 78.49 },
  Chennai: { lat: 13.08, lon: 80.27 },
  Vijayawada: { lat: 16.51, lon: 80.65 },
  Mysuru: { lat: 12.3, lon: 76.64 },
  Coimbatore: { lat: 11.02, lon: 76.96 },
  Hubballi: { lat: 15.36, lon: 75.12 },
  Mumbai: { lat: 19.08, lon: 72.88 },
  Pune: { lat: 18.52, lon: 73.86 },
  Ahmedabad: { lat: 23.02, lon: 72.57 },
  Surat: { lat: 21.17, lon: 72.83 },
  Nashik: { lat: 20.0, lon: 73.79 },
  Panaji: { lat: 15.49, lon: 73.83 },
};

export const GROUPS: GroupInfo[] = [
  { id: 'deccan', name: 'Deccan corridor', region: 'South' },
  { id: 'western', name: 'Western corridor', region: 'West' },
  { id: 'stress', name: 'Stress-test fleet', region: 'Synthetic' },
  { id: 'guest', name: "Judges' fleet (phones)", region: 'Live audience' },
];

const PRODUCTS = [
  'Measles-rubella (sim)',
  'Rotavirus (sim)',
  'Hepatitis B (sim)',
  'Inactivated polio (sim)',
  'Pentavalent (sim)',
  'Tetanus-diphtheria (sim)',
];

const LANES: Record<string, [string, string][]> = {
  deccan: [
    ['Bengaluru', 'Hyderabad'],
    ['Bengaluru', 'Chennai'],
    ['Chennai', 'Hyderabad'],
    ['Hyderabad', 'Vijayawada'],
    ['Bengaluru', 'Mysuru'],
    ['Coimbatore', 'Bengaluru'],
    ['Chennai', 'Vijayawada'],
    ['Hubballi', 'Bengaluru'],
    ['Mysuru', 'Coimbatore'],
    ['Hyderabad', 'Hubballi'],
  ],
  western: [
    ['Mumbai', 'Pune'],
    ['Mumbai', 'Ahmedabad'],
    ['Pune', 'Nashik'],
    ['Ahmedabad', 'Surat'],
    ['Surat', 'Mumbai'],
    ['Nashik', 'Mumbai'],
    ['Pune', 'Panaji'],
    ['Mumbai', 'Hubballi'],
    ['Ahmedabad', 'Nashik'],
    ['Panaji', 'Mumbai'],
  ],
};

const FACILITIES: Record<string, string[]> = {
  deccan: ['Bengaluru', 'Hyderabad'],
  western: ['Mumbai', 'Ahmedabad'],
};

/** Simple deterministic hash for stable per-device simulated values. */
function h(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export const NAMED_DEVICE_COUNT = 24;

/** Build the device catalogue. The first 24 are the named fleet; the rest are stress devices. */
export function buildFleet(total = NAMED_DEVICE_COUNT): DeviceInfo[] {
  const out: DeviceInfo[] = [];
  let i = 0;
  for (const g of ['deccan', 'western'] as const) {
    const prefix = g === 'deccan' ? 'DC' : 'WC';
    LANES[g].forEach(([from, to], k) => {
      const doses = 2000 + Math.round(h(i) * 18) * 500;
      out.push({
        id: `${prefix}-S${String(k + 1).padStart(2, '0')}`,
        name: `${from} → ${to}`,
        kind: 'shipment',
        groupId: g,
        origin: from,
        destination: to,
        product: PRODUCTS[i % PRODUCTS.length],
        simulatedDoses: doses,
        simulatedValueInr: doses * (40 + Math.round(h(i + 99) * 160)),
      });
      i++;
    });
    FACILITIES[g].forEach((city, k) => {
      const doses = 20000 + Math.round(h(i) * 20) * 1000;
      out.push({
        id: `${prefix}-F${String(k + 1).padStart(2, '0')}`,
        name: `${city} cold room`,
        kind: 'facility',
        groupId: g,
        origin: city,
        destination: city,
        product: 'Mixed vaccine stock (sim)',
        simulatedDoses: doses,
        simulatedValueInr: doses * 90,
      });
      i++;
    });
  }
  for (let k = out.length; k < total; k++) {
    const n = k - NAMED_DEVICE_COUNT + 1;
    out.push({
      id: `ST-${String(n).padStart(4, '0')}`,
      name: `Stress logger ${n}`,
      kind: 'shipment',
      groupId: 'stress',
      origin: 'Synthetic',
      destination: 'Synthetic',
      product: 'Synthetic load (sim)',
      simulatedDoses: 0,
      simulatedValueInr: 0,
    });
  }
  return out.slice(0, Math.max(total, 0));
}

export const MAX_DEVICES = 2000;

/** Trucks that audience members "drive" from their phones (group `guest`). */
export const GUEST_LANES: [string, string][] = [
  ['Bengaluru', 'Mysuru'],
  ['Bengaluru', 'Chennai'],
  ['Bengaluru', 'Hyderabad'],
  ['Mumbai', 'Pune'],
  ['Hyderabad', 'Vijayawada'],
  ['Chennai', 'Coimbatore'],
  ['Pune', 'Panaji'],
  ['Ahmedabad', 'Surat'],
  ['Hubballi', 'Bengaluru'],
  ['Nashik', 'Mumbai'],
  ['Coimbatore', 'Mysuru'],
  ['Surat', 'Mumbai'],
];

export function guestFleet(): DeviceInfo[] {
  return GUEST_LANES.map(([from, to], k) => ({
    id: `GT-${String(k + 1).padStart(2, '0')}`,
    name: `Open truck ${k + 1} (${from} → ${to})`,
    kind: 'shipment' as const,
    groupId: 'guest',
    origin: from,
    destination: to,
    product: 'Demo load (sim)',
    simulatedDoses: 1000,
    simulatedValueInr: 100_000,
  }));
}
