import type { ConnectionKind, Watermark } from '../api/types';

export const KIND_LABEL: Record<ConnectionKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongo: 'MongoDB',
  cosmos: 'Cosmos DB',
  csv: 'CSV files',
};

const numberFormat = new Intl.NumberFormat();

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

const BYTE_UNITS = ['KB', 'MB', 'GB'];

/** Binary units (1 MB = 1024 KB), matching how the engine applies the upload limit. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRelative(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDateTime(iso);
}

export function formatDuration(startIso: string, endIso: string | null): string {
  const ms = new Date(endIso ?? Date.now()).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function formatWatermark(watermark: Watermark | null): string {
  if (!watermark) return 'Not set';
  return watermark.type === 'date' ? formatDateTime(String(watermark.value)) : String(watermark.value);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
