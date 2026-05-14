import { StockItem } from '../../app/types/stock';
import { SELECTORS } from './selectors';

/**
 * Normalises a raw weight/gramasi string into a canonical form.
 * Examples: "1 gram" | "1,0 gr" | "  1.0 GR " → "1.0 gr"
 */
export function parseWeight(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/(\d+[,.]?\d*)\s*(gr|gram|g)\b/);
  if (match) {
    const num = parseFloat(match[1].replace(',', '.'));
    return `${num} gr`;
  }
  // Return cleaned string if pattern doesn't match (rare edge case)
  return raw.trim();
}

/**
 * Converts a raw quantity string to a non-negative integer.
 * Strips any non-digit characters; returns 0 for empty/invalid input.
 */
export function parseQty(raw: string): number {
  const digits = raw.trim().replace(/[^0-9]/g, '');
  if (!digits) return 0;
  const num = parseInt(digits, 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Returns true when the given text contains any sold-out keyword.
 */
export function isSoldOut(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return SELECTORS.stock.soldOutTexts.some((pattern) => lower.includes(pattern));
}

/**
 * Constructs a StockItem from raw scraped values.
 *
 * @param rawWeight  - Gramasi string as seen in the DOM.
 * @param rawQty     - Qty string or number as seen in the DOM.
 * @param rawStatus  - Optional status text (e.g. "Stok Habis"); triggers qty=0 when sold-out.
 */
export function createStockItem(
  rawWeight: string,
  rawQty: string | number,
  rawStatus?: string,
): StockItem {
  const weight = parseWeight(rawWeight);

  let qty: number;
  let available: boolean;

  if (rawStatus && isSoldOut(rawStatus)) {
    qty = 0;
    available = false;
  } else if (typeof rawQty === 'number') {
    qty = rawQty;
    available = qty > 0;
  } else {
    qty = parseQty(rawQty);
    available = qty > 0;
  }

  return { weight, qty, available };
}
