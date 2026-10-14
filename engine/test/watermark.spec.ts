import { describe, expect, it } from 'vitest';
import { StoredWatermark, fromStoredWatermark, toStoredWatermark, upgradedWatermark } from '../src/sync/watermark';

const HOUR = 60 * 60 * 1000;

describe('date watermarks across the switch to UTC naive timestamps', () => {
  it('marks every date watermark it saves as UTC', () => {
    expect(toStoredWatermark(new Date('2025-03-02T23:30:00Z'))).toEqual({ type: 'date', value: '2025-03-02T23:30:00.000Z', utc: true });
  });

  it('resumes a marked watermark at exactly the moment it was saved', () => {
    const saved = toStoredWatermark(new Date('2025-03-02T23:30:00Z'))!;
    expect(fromStoredWatermark(saved)).toEqual(new Date('2025-03-02T23:30:00Z'));
  });

  it('resumes a watermark saved by an older engine 14 hours earlier, so no row in its offset window is skipped', () => {
    const old: StoredWatermark = { type: 'date', value: '2025-03-03T04:30:00.000Z' };
    expect((fromStoredWatermark(old) as Date).getTime()).toBe(Date.parse('2025-03-03T04:30:00.000Z') - 14 * HOUR);
  });

  it('leaves other watermark types untouched', () => {
    expect(fromStoredWatermark({ type: 'number', value: 42 })).toBe(42);
    expect(fromStoredWatermark({ type: 'string', value: '2025-03-03T04:30:00.000Z' })).toBe('2025-03-03T04:30:00.000Z');
    expect(fromStoredWatermark({ type: 'objectId', value: '64b7f0c2a1b2c3d4e5f60718' })).toBe('64b7f0c2a1b2c3d4e5f60718');
    expect(toStoredWatermark(42)).toEqual({ type: 'number', value: 42 });
  });

  it('upgrades an unmarked date watermark once: moved back and marked, so it is never moved again', () => {
    const upgraded = upgradedWatermark({ type: 'date', value: '2025-03-03T04:30:00.000Z' });
    expect(upgraded).toEqual({ type: 'date', value: '2025-03-02T14:30:00.000Z', utc: true });
    expect(upgradedWatermark(upgraded)).toBe(upgraded);
    const number: StoredWatermark = { type: 'number', value: 42 };
    expect(upgradedWatermark(number)).toBe(number);
  });
});
