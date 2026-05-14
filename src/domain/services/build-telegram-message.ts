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
 *
 *   Update Jam: 11:08:40 WIB ⏰
 *   🔗 <a href="...">Beli Sekarang</a>
 *
 * Rendering rules:
 *   - New stock (0 → 1) : bold + 🆕
 *   - Available (unchanged) : plain text
 *   - Out of stock           : hidden (not shown in message)
 */
export function buildTelegramMessage(change: LocationStockChange): string {
  const time = formatTime(new Date(change.scrapedAt));

  const availableItems = change.allItems.filter(({ available }) => available);

  const gramasiLines = availableItems
    .map(({ weight }) => `- ${weight}`)
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
    `🔗 <a href="https://www.logammulia.com/id/purchase/gold">Beli di ${change.location}</a>`,
  ].join('\n');
}
