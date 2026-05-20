export type ChangeType = 'increase' | 'decrease' | 'soldout';

export interface StockChangeItem {
  weight: string;
  oldQty: number;
  newQty: number;
  type: ChangeType;
}

export interface StockItemSummary {
  weight: string;
  available: boolean;
}

export interface LocationStockChange {
  location: string;
  /** Gramasi items that changed (increase, decrease, or soldout). */
  changes: StockChangeItem[];
  /** ALL gramasi for this location with their current availability status. */
  allItems: StockItemSummary[];
  scrapedAt: string;
}

export function hasIncrease(change: StockChangeItem): boolean {
  return change.type === 'increase';
}

export function hasDecrease(change: StockChangeItem): boolean {
  return change.type === 'decrease' || change.type === 'soldout';
}

export function filterIncreases(changes: StockChangeItem[]): StockChangeItem[] {
  return changes.filter(hasIncrease);
}

export function filterDecreases(changes: StockChangeItem[]): StockChangeItem[] {
  return changes.filter(hasDecrease);
}
