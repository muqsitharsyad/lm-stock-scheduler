import { LocationStockChange, filterIncreases, filterDecreases } from '../entities/stock-change';
import { formatTime } from '../../app/utils/time';

/**
 * Builds the Telegram notification message (HTML parse mode) for a single location.
 *
 * Format:
 *
 * Tersedia:
 *   Info Stock Terbaru! 📦✨
 *   Lokasi: BELM - Pengiriman Ekspedisi, Pulogadung Jakarta, Jakarta 📍
 *   Gramasi:
 *   - 2 gr
 *   - 5 gr
 *   Update Jam: 10:14:59 WIB ⏰
 *   🔗 Beli Sekarang
 *
 * Habis:
 *   Info Stock Terbaru! 📦✨
 *   Lokasi: BELM - Pengiriman Ekspedisi, Pulogadung Jakarta, Jakarta 📍
 *   Gramasi:
 *   - 2 gr (habis)
 *   Update Jam: 10:15:59 WIB ⏰
 */
export function buildTelegramMessage(change: LocationStockChange): string {
  const time = formatTime(new Date(change.scrapedAt));
  const increases = filterIncreases(change.changes);
  const decreases = filterDecreases(change.changes);

  const hasIncreases = increases.length > 0;
  const hasDecreases = decreases.length > 0;

  if (hasIncreases) {
    return buildAvailableMessage(change, time);
  }

  if (hasDecreases) {
    return buildUnavailableMessage(change, decreases, time);
  }

  return buildAvailableMessage(change, time);
}

function buildAvailableMessage(change: LocationStockChange, time: string): string {
  const availableItems = change.allItems.filter(({ available }) => available);

  const gramasiLines = availableItems
    .map(({ weight }) => `- ${weight}`)
    .join('\n');

  const lines = [
    'Info Stock Terbaru! 📦✨',
    '',
    `Lokasi: ${change.location} 📍`,
    '',
    'Gramasi:',
    gramasiLines || '- (tidak ada)',
    '',
    `Update Jam: ${time} WIB ⏰`,
    `🔗 <a href="https://www.logammulia.com/id/purchase/gold">Beli Sekarang</a>`,
  ];

  return lines.join('\n');
}

function buildUnavailableMessage(
  change: LocationStockChange,
  decreases: { weight: string }[],
  time: string,
): string {
  const soldOutWeights = decreases.map(({ weight }) => weight);

  const gramasiLines = soldOutWeights
    .map((w) => `- ${w} (habis)`)
    .join('\n');

  const lines = [
    'Info Stock Terbaru! 📦✨',
    '',
    `Lokasi: ${change.location} 📍`,
    '',
    'Gramasi:',
    gramasiLines,
    '',
    `Update Jam: ${time} WIB ⏰`,
  ];

  return lines.join('\n');
}
