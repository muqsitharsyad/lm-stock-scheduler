import { StockSnapshot } from '../../app/types/stock';
import { LocationStockChange, StockChangeItem, ChangeType } from '../entities/stock-change';

export interface CompareOptions {
  /** Report stock decreases and sold-out events. Default: true */
  notifyDecrease?: boolean;
}

/**
 * Compares the new snapshot against the previous one and returns
 * locations/items where qty has changed (increase, decrease, or soldout).
 *
 * Rules:
 *  - qty 0 -> 0 : no change, skip
 *  - qty N -> N : no change, skip
 *  - qty 0 -> M where M > 0 : increase, report
 *  - qty N -> M where M > N : increase, report
 *  - qty N -> 0             : soldout, report (if notifyDecrease=true)
 *  - qty N -> M where M < N : decrease, report (if notifyDecrease=true)
 */
export function compareSnapshots(
  oldSnapshot: StockSnapshot | null,
  newSnapshot: StockSnapshot,
  options: CompareOptions = {},
): LocationStockChange[] {
  const { notifyDecrease = true } = options;
  const changes: LocationStockChange[] = [];

  for (const newLocation of newSnapshot) {
    const oldLocation = oldSnapshot?.find((l) => l.location === newLocation.location);
    const locationChanges: StockChangeItem[] = [];

    for (const newItem of newLocation.items) {
      const oldItem = oldLocation?.items.find((i) => i.weight === newItem.weight);
      const oldQty = oldItem?.qty ?? 0;
      const newQty = newItem.qty;

      if (newQty > oldQty) {
        locationChanges.push({ weight: newItem.weight, oldQty, newQty, type: 'increase' });
      } else if (notifyDecrease && newQty < oldQty) {
        const type: ChangeType = newQty === 0 ? 'soldout' : 'decrease';
        locationChanges.push({ weight: newItem.weight, oldQty, newQty, type });
      }
    }

    // Also detect items that existed in old snapshot but disappeared from new
    // (e.g. removed from page entirely — treat as soldout)
    if (notifyDecrease && oldLocation) {
      for (const oldItem of oldLocation.items) {
        const stillExists = newLocation.items.find((i) => i.weight === oldItem.weight);
        if (!stillExists && oldItem.qty > 0) {
          locationChanges.push({
            weight: oldItem.weight,
            oldQty: oldItem.qty,
            newQty: 0,
            type: 'soldout',
          });
        }
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
