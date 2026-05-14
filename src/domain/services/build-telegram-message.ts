import { LocationStockChange } from '../entities/stock-change';
import { formatTime } from '../../app/utils/time';

/**
 * Builds the Telegram notification message (HTML parse mode) for a single location.
 *
 * Format:
 *   Info Stock Terbaru! 📦✨
 *
 *   Lokasi: BELM Pulogadung Ekspedisi 📍
 *
 *   Gramasi:
 *   - 5 gr
 *   - <b>10 gr (new stock! 🆕)</b>
 *   - <s>25 gr</s>
 *
 *   Update Jam: 11:08:40 WIB ⏰
 *
 * Rendering rules:
 *   - New stock (0 → 1) : bold + 🆕
 *   - Available (unchanged) : plain text
 *   - Out of stock (qty = 0)  : strikethrough
 */
export function buildTelegramMessage(change: LocationStockChange): string {
  const time = formatTime(new Date(change.scrapedAt));
  const newWeights = new Set(change.changes.map((c) => c.weight));

  const gramasiLines = change.allItems
    .map(({ weight, available }) => {
      if (!available) {
        return `- <s>${weight}</s>`;
      }
      if (newWeights.has(weight)) {
        return `- <b>${weight} (new stock! 🆕)</b>`;
      }
      return `- ${weight}`;
    })
    .join('\n');

  return [
    'Info Stock Terbaru! 📦✨',
    '',
    `Lokasi: ${change.location} 📍`,
    '',
    'Gramasi:',
    gramasiLines,
    '',
    `Update Jam: ${time} WIB ⏰`,
  ].join('\n');
}
