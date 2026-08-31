import { afterEach, describe, expect, it } from 'bun:test';

import { nextFire, parseCron, type CronFields } from './cron.js';

const EVERY: CronFields = { minute: null, hour: null, dayOfMonth: null, month: null, dayOfWeek: null };

describe('parseCron', () => {
  describe('syntax forms', () => {
    const cases: readonly (readonly [string, CronFields])[] = [
      ['* * * * *', EVERY],
      ['5 * * * *', { ...EVERY, minute: [5] }],
      ['1-5 * * * *', { ...EVERY, minute: [1, 2, 3, 4, 5] }],
      ['*/15 * * * *', { ...EVERY, minute: [0, 15, 30, 45] }],
      ['10-20/5 * * * *', { ...EVERY, minute: [10, 15, 20] }],
      ['0,15,30 * * * *', { ...EVERY, minute: [0, 15, 30] }],
      ['0-59 * * * *', EVERY],
      ['* * 1-31 * *', EVERY],
      ['0 9 * * 0', { ...EVERY, minute: [0], hour: [9], dayOfWeek: [0] }],
      ['0 9 * * 7', { ...EVERY, minute: [0], hour: [9], dayOfWeek: [0] }],
      ['0 9 * * mon-fri', { ...EVERY, minute: [0], hour: [9], dayOfWeek: [1, 2, 3, 4, 5] }],
      ['0 9 * * SUN', { ...EVERY, minute: [0], hour: [9], dayOfWeek: [0] }],
      ['0 0 1 jan *', { ...EVERY, minute: [0], hour: [0], dayOfMonth: [1], month: [1] }],
      ['0 0 1 JAN-MAR *', { ...EVERY, minute: [0], hour: [0], dayOfMonth: [1], month: [1, 2, 3] }]
    ];

    it.each(cases)('should parse "%s"', (expression, expected) => {
      expect(parseCron(expression)).toEqual(expected);
    });
  });

  describe('macros', () => {
    const cases: readonly (readonly [string, CronFields])[] = [
      ['@hourly', { ...EVERY, minute: [0] }],
      ['@daily', { ...EVERY, minute: [0], hour: [0] }],
      ['@midnight', { ...EVERY, minute: [0], hour: [0] }],
      ['@weekly', { ...EVERY, minute: [0], hour: [0], dayOfWeek: [0] }],
      ['@monthly', { ...EVERY, minute: [0], hour: [0], dayOfMonth: [1] }],
      ['@yearly', { ...EVERY, minute: [0], hour: [0], dayOfMonth: [1], month: [1] }],
      ['@annually', { ...EVERY, minute: [0], hour: [0], dayOfMonth: [1], month: [1] }]
    ];

    it.each(cases)('should expand "%s"', (macro, expected) => {
      expect(parseCron(macro)).toEqual(expected);
    });

    it('should throw a named error on an unknown macro', () => {
      expect(() => parseCron('@fortnightly')).toThrow(/Invalid cron expression "@fortnightly".*unknown macro/);
    });
  });

  describe('day-of-month/day-of-week conflict', () => {
    it('should throw when both fields are restricted to a single value', () => {
      expect(() => parseCron('0 0 1 * 1')).toThrow(
        /Invalid cron expression "0 0 1 \* 1".*day-of-month and day-of-week cannot both be restricted/
      );
    });

    it('should throw when both fields are restricted via a range', () => {
      expect(() => parseCron('0 0 1-5 * mon-fri')).toThrow(/day-of-month and day-of-week cannot both be restricted/);
    });

    it('should not throw when only day-of-month is restricted', () => {
      expect(() => parseCron('0 0 1 * *')).not.toThrow();
    });

    it('should not throw when only day-of-week is restricted', () => {
      expect(() => parseCron('0 0 * * 1')).not.toThrow();
    });
  });

  describe('malformed expressions', () => {
    it('should throw naming the expression on the wrong field count', () => {
      expect(() => parseCron('* * * *')).toThrow(
        /Invalid cron expression "\* \* \* \*".*expected 5 space-separated fields, got 4/
      );
    });

    it('should throw naming the field and token on an out-of-range value', () => {
      expect(() => parseCron('60 * * * *')).toThrow(/minute field: token "60" is out of range \(0-59\)/);
    });

    it('should throw naming the field and token on a reversed range', () => {
      expect(() => parseCron('5-1 * * * *')).toThrow(/minute field: reversed range "5-1"/);
    });

    it('should throw on a zero step', () => {
      expect(() => parseCron('*/0 * * * *')).toThrow(/step must be a positive integer/);
    });

    it('should throw on a negative step', () => {
      expect(() => parseCron('*/-1 * * * *')).toThrow(/step must be a positive integer/);
    });

    it.each(['*/0x10 * * * *', '*/1e2 * * * *', '*/+3 * * * *', '*/2.0 * * * *'])(
      'should throw on a numeric-literal step that is not cron syntax: %s',
      expression => {
        expect(() => parseCron(expression)).toThrow(/step must be a positive integer/);
      }
    );

    it('should throw on a step attached to a bare value', () => {
      expect(() => parseCron('5/15 * * * *')).toThrow(/a step is only valid with "\*" or a range/);
    });

    it('should throw naming the field and token on an unparseable token', () => {
      expect(() => parseCron('abc * * * *')).toThrow(/minute field: token "abc"/);
    });

    it('should throw naming the field and token on a range with too many hyphens', () => {
      expect(() => parseCron('1-2-3 * * * *')).toThrow(/minute field: could not parse token "1-2-3"/);
    });

    it('should throw naming the field and token on a step with too many slashes', () => {
      expect(() => parseCron('*/2/3 * * * *')).toThrow(/minute field: could not parse token "\*\/2\/3"/);
    });
  });
});

describe('nextFire', () => {
  it('should find the next simple daily occurrence, rolling to the next day', () => {
    const fields = parseCron('@daily');
    const result = nextFire(fields, new Date(2026, 0, 1, 5, 0));
    expect(result).toEqual(new Date(2026, 0, 2, 0, 0));
  });

  it('should skip a weekend to the next weekday in a weekday range', () => {
    const fields = parseCron('0 9 * * mon-fri');
    const result = nextFire(fields, new Date(2026, 0, 2, 10, 0));
    expect(result).toEqual(new Date(2026, 0, 5, 9, 0));
  });

  it('should honor a step expression within the same day', () => {
    const fields = parseCron('*/15 * * * *');
    const result = nextFire(fields, new Date(2026, 0, 1, 0, 5));
    expect(result).toEqual(new Date(2026, 0, 1, 0, 15));
  });

  it('should roll over the month boundary', () => {
    const fields = parseCron('@monthly');
    const result = nextFire(fields, new Date(2026, 0, 31, 12, 0));
    expect(result).toEqual(new Date(2026, 1, 1, 0, 0));
  });

  it('should return null when the expression can never fire within a year', () => {
    const fields = parseCron('0 0 30 2 *');
    const result = nextFire(fields, new Date(2026, 0, 1, 0, 0));
    expect(result).toBeNull();
  });

  describe('DST transition', () => {
    const originalTz = process.env['TZ'];

    afterEach(() => {
      if (originalTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTz;
    });

    it('should terminate and land on the next valid local time when the target hour does not exist', () => {
      process.env['TZ'] = 'America/New_York';
      // Spring-forward in America/New_York, 2026: 02:00 local on March 8 does
      // not exist (clocks jump straight to 03:00), so "0 2 * * *" cannot fire
      // that day — the next valid occurrence is 02:00 the following day.
      const fields = parseCron('0 2 * * *');
      const result = nextFire(fields, new Date(2026, 2, 7, 23, 0));
      expect(result).toEqual(new Date(2026, 2, 9, 2, 0));
    });
  });
});
