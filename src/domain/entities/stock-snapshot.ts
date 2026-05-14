import { LocationStock, StockSnapshot } from '../../app/types/stock';

export function createSnapshot(locations: LocationStock[]): StockSnapshot {
  return locations;
}

export function findLocation(
  snapshot: StockSnapshot,
  locationName: string,
): LocationStock | undefined {
  return snapshot.find((l) => l.location === locationName);
}
