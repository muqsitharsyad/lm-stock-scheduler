export interface StockChangeItem {
  weight: string;
  oldQty: number;
  newQty: number;
}

export interface StockItemSummary {
  weight: string;
  available: boolean;
}

export interface LocationStockChange {
  location: string;
  /** Gramasi items that newly became available (qty 0 → 1). */
  changes: StockChangeItem[];
  /** ALL gramasi for this location with their current availability status. */
  allItems: StockItemSummary[];
  scrapedAt: string;
}

export function hasIncrease(change: StockChangeItem): boolean {
  return change.newQty > change.oldQty;
}

export function filterIncreases(changes: StockChangeItem[]): StockChangeItem[] {
  return changes.filter(hasIncrease);
}
