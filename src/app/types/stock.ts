export interface StockItem {
  weight: string;      // e.g. "1.0 gr"
  qty: number;         // 0 when not available
  available: boolean;  // false when sold out
}

export interface LocationStock {
  location: string;        // human-readable label, e.g. "BELM Pulogadung Ekspedisi"
  locationCode?: string;   // internal code used by /do-change-location, e.g. "ABDH"
  items: StockItem[];
  scrapedAt: string; // ISO 8601 with Jakarta offset, e.g. "2026-05-14T12:02:24+07:00"
}

export type StockSnapshot = LocationStock[];
