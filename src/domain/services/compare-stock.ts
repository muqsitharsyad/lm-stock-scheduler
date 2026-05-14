import { StockSnapshot } from '../../app/types/stock';
import { LocationStockChange, StockChangeItem } from '../entities/stock-change';

/**
 * Compares the new snapshot against the previous one and returns only
 * locations/items where qty has increased.
 *
 * Rules:
 *  - qty 0 -> 0 : no change, skip
 *  - qty N -> N : no change, skip
 *  - qty N -> M where M < N : decrease, skip
 *  - qty 0 -> M where M > 0 : increase, report
 *  - qty N -> M where M > N : increase, report
 */
export function compareSnapshots(
  oldSnapshot: StockSnapshot | null,
  newSnapshot: StockSnapshot,
): LocationStockChange[] {
  const changes: LocationStockChange[] = [];

  for (const newLocation of newSnapshot) {
    const oldLocation = oldSnapshot?.find((l) => l.location === newLocation.location);
    const locationChanges: StockChangeItem[] = [];

    for (const newItem of newLocation.items) {
      const oldItem = oldLocation?.items.find((i) => i.weight === newItem.weight);
      const oldQty = oldItem?.qty ?? 0;
      const newQty = newItem.qty;

      if (newQty > oldQty) {
        locationChanges.push({ weight: newItem.weight, oldQty, newQty });
      }
    }

    if (locationChanges.length > 0) {
      const allItems = newLocation.items.map((i) => ({
        weight: i.weight,
        available: i.qty > 0,
      }));
      changes.push({
        location: newLocation.location,
        changes: locationChanges,
        allItems,
        scrapedAt: newLocation.scrapedAt,
      });
    }
  }

  return changes;
}
