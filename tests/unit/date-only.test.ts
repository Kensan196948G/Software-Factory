import { afterEach, describe, expect, it } from 'vitest';
import { dateOnly } from '../../src/api/repo.js';

const originalTz = process.env.TZ;

describe('dateOnly（pg の date の変換）', () => {
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  for (const tz of ['Asia/Tokyo', 'UTC', 'America/New_York']) {
    it(`${tz} でローカル深夜の Date が同じ年月日になる`, () => {
      process.env.TZ = tz;
      expect(dateOnly(new Date(2026, 11, 1))).toBe('2026-12-01');
      expect(dateOnly(new Date(2027, 0, 1))).toBe('2027-01-01');
    });
  }
});
