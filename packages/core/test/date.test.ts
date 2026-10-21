import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  formatDateCN,
  formatDateRangeCN,
  formatDateShort,
  fromUtcMillis,
  isLocalDate,
  isPast,
  isValidStay,
  isValidTimeZone,
  localDateInZone,
  nightSegments,
  nights,
  parseLocalDate,
  toLocalDate,
  toUtcMillis,
  today,
} from '../src/date.js';

/**
 * 保护日期真源（date.ts）的规则：
 *  1. 住期是「按天」而不是「按瞬间」：2026-02-30 这种不存在的日期必须被判非法。
 *  2. 所有算术走 UTC，不能被 DST / 时区漂移影响。
 *  3. 入住区间含头不含尾：2026-10-20 → 2026-10-22 == 2 晚。
 */

describe('isLocalDate() — 合法日期判定', () => {
  it('接受真实存在的日期', () => {
    expect(isLocalDate('2026-10-20')).toBe(true);
    expect(isLocalDate('2026-02-28')).toBe(true);
    expect(isLocalDate('2024-02-29')).toBe(true);
  });

  it('拒绝不存在的日历日：2026-02-30', () => {
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-04-31')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-00-10')).toBe(false);
    expect(isLocalDate('2026-01-00')).toBe(false);
  });

  it('拒绝格式不对的字符串', () => {
    expect(isLocalDate('2026-1-1')).toBe(false);
    expect(isLocalDate('26-01-01')).toBe(false);
    expect(isLocalDate('2026/01/01')).toBe(false);
    expect(isLocalDate('')).toBe(false);
  });
});

describe('parseLocalDate()', () => {
  it('合法日期原样返回', () => {
    expect(parseLocalDate('2026-10-20')).toBe('2026-10-20');
  });

  it('非法日期抛 TypeError', () => {
    expect(() => parseLocalDate('2026-02-30')).toThrow(TypeError);
    expect(() => parseLocalDate('2026-02-30')).toThrow(/Invalid local date/);
  });
});

describe('toUtcMillis() / fromUtcMillis() / toLocalDate()', () => {
  it('UTC 毫秒与本地日期互转', () => {
    expect(toUtcMillis('2026-10-20')).toBe(Date.UTC(2026, 9, 20));
    expect(fromUtcMillis(Date.UTC(2026, 9, 20))).toBe('2026-10-20');
    expect(toLocalDate(new Date('2026-10-20T23:59:59.999Z'))).toBe('2026-10-20');
  });
});

describe('today() / isPast()', () => {
  it('today 取 UTC 当天', () => {
    expect(today(new Date('2026-10-20T23:59:59.999Z'))).toBe('2026-10-20');
    expect(today(new Date('2026-10-21T00:00:00.000Z'))).toBe('2026-10-21');
  });

  it('isPast 只看日期，不看时刻', () => {
    const now = new Date('2026-10-20T00:00:00.000Z');
    expect(isPast('2026-10-19', now)).toBe(true);
    expect(isPast('2026-10-20', now)).toBe(false);
    expect(isPast('2026-10-21', now)).toBe(false);
  });
});

describe('diffDays() — 跨天计算', () => {
  it('同月跨天', () => {
    expect(diffDays('2026-10-20', '2026-10-22')).toBe(2);
  });

  it('跨月', () => {
    expect(diffDays('2026-10-30', '2026-11-02')).toBe(3);
    expect(diffDays('2026-11-30', '2026-12-01')).toBe(1);
  });

  it('跨年', () => {
    expect(diffDays('2025-12-31', '2026-01-01')).toBe(1);
    expect(diffDays('2025-01-01', '2026-01-01')).toBe(365);
  });

  it('闰年 2 月按 29 天算', () => {
    expect(diffDays('2024-02-01', '2024-03-01')).toBe(29);
    expect(diffDays('2026-02-01', '2026-03-01')).toBe(28);
  });

  it('反向为负', () => {
    expect(diffDays('2026-10-22', '2026-10-20')).toBe(-2);
  });
});

describe('addDays()', () => {
  it('同月推进', () => {
    expect(addDays('2026-10-20', 2)).toBe('2026-10-22');
  });

  it('跨月', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('跨年', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('闰年 2 月', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('加 0 天返回原值', () => {
    expect(addDays('2026-10-20', 0)).toBe('2026-10-20');
  });
});

describe('nights() / isValidStay()', () => {
  it('入住区间按晚数计算', () => {
    expect(nights('2026-10-20', '2026-10-22')).toBe(2);
    expect(nights('2026-10-20', '2026-10-21')).toBe(1);
  });

  it('同日或反向区间抛 RangeError', () => {
    expect(() => nights('2026-10-20', '2026-10-20')).toThrow(RangeError);
    expect(() => nights('2026-10-20', '2026-10-20')).toThrow(/Invalid stay range/);
    expect(() => nights('2026-10-22', '2026-10-20')).toThrow(RangeError);
  });

  it('isValidStay 不抛异常，只返回布尔', () => {
    expect(isValidStay('2026-10-20', '2026-10-22')).toBe(true);
    expect(isValidStay('2026-10-20', '2026-10-20')).toBe(false);
    expect(isValidStay('2026-10-22', '2026-10-20')).toBe(false);
  });
});

describe('nightSegments() — 逐晚切分', () => {
  it('含入住日、不含退房日', () => {
    expect(nightSegments('2026-10-20', '2026-10-23')).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
  });

  it('跨月切分', () => {
    expect(nightSegments('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('段数恒等于夜数', () => {
    expect(nightSegments('2026-10-20', '2026-11-05')).toHaveLength(16);
  });

  it('非法区间抛 RangeError', () => {
    expect(() => nightSegments('2026-10-20', '2026-10-20')).toThrow(RangeError);
  });
});

describe('formatDateCN() / formatDateShort() / formatDateRangeCN()', () => {
  it('中文长日期去掉前导零', () => {
    expect(formatDateCN('2026-10-20')).toBe('2026年10月20日');
    expect(formatDateCN('2026-01-05')).toBe('2026年1月5日');
  });

  it('短日期 M/D', () => {
    expect(formatDateShort('2026-10-20')).toBe('10/20');
    expect(formatDateShort('2026-01-05')).toBe('1/5');
  });

  it('中文日期区间', () => {
    expect(formatDateRangeCN('2026-10-20', '2026-10-22')).toBe('2026年10月20日 - 2026年10月22日');
  });
});

describe('isValidTimeZone() — 物业时区校验', () => {
  it('接受运行时认识的 IANA 时区', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Asia/Bangkok')).toBe(true);
  });

  it('拒绝未知时区与空串', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });
});

describe('localDateInZone() — 物业墙上时钟的当天', () => {
  // 同一个瞬间，在纽约还是 10-20，在曼谷已经是 10-21。
  const instant = new Date('2026-10-20T23:30:00.000Z');

  it('默认按 UTC 计算', () => {
    expect(localDateInZone(instant)).toBe('2026-10-20');
  });

  it('按目标时区计算当天', () => {
    expect(localDateInZone(instant, 'America/New_York')).toBe('2026-10-20');
    expect(localDateInZone(instant, 'Asia/Bangkok')).toBe('2026-10-21');
    expect(localDateInZone(instant, 'Asia/Tokyo')).toBe('2026-10-21');
  });

  it('非法时区回落到 UTC，而不是抛错', () => {
    expect(localDateInZone(instant, 'Not/AZone')).toBe('2026-10-20');
  });

  it('当地日期在时区偏移后仍能正确跨日', () => {
    expect(localDateInZone(new Date('2026-10-20T00:30:00.000Z'), 'Asia/Bangkok')).toBe('2026-10-20');
  });
});
