import { describe, expect, it } from 'vitest';
import {
  fingerprintStayContext,
  isSameStayContext,
  stayGuests,
  stayNights,
} from '../src/stay-context.js';
import type { StayContext } from '../src/stay-context.js';

/**
 * 保护 StayContext 指纹（stay-context.ts）的规则：
 *  Agoda 要求 Search → Precheck → Book 三次请求的参数完全一致，否则拒绝下单。
 *  指纹因此必须满足两条：
 *   - 稳定：同一份参数反复计算结果不变（能当幂等键 / 落库凭证）；
 *   - 敏感：任何会影响房价或库存的参数一变，指纹必须变。
 */

const BASE: StayContext = {
  supplierHotelId: '90001',
  checkIn: '2026-11-01',
  checkOut: '2026-11-03',
  rooms: 1,
  adults: 2,
  childAges: [],
  currency: 'USD',
  nationality: 'CN',
};

const HEX64 = /^[0-9a-f]{64}$/;

describe('fingerprintStayContext() — 形状', () => {
  it('是 64 位小写十六进制（SHA-256）', () => {
    const fp = fingerprintStayContext(BASE);
    expect(fp).toMatch(HEX64);
    expect(fp).toHaveLength(64);
  });
});

describe('fingerprintStayContext() — 稳定性', () => {
  it('同参数两次调用结果完全相同', () => {
    expect(fingerprintStayContext(BASE)).toBe(fingerprintStayContext(BASE));
  });

  it('同参数的另一个对象实例结果也相同', () => {
    const copy: StayContext = { ...BASE, childAges: [] };
    expect(fingerprintStayContext(copy)).toBe(fingerprintStayContext(BASE));
  });

  it('儿童年龄顺序不同不影响指纹（比较的是年龄集合，不是顺序）', () => {
    const a: StayContext = { ...BASE, childAges: [8, 4] };
    const b: StayContext = { ...BASE, childAges: [4, 8] };
    expect(fingerprintStayContext(a)).toBe(fingerprintStayContext(b));
  });

  it('国籍大小写不影响指纹', () => {
    const lower: StayContext = { ...BASE, nationality: 'cn' };
    expect(fingerprintStayContext(lower)).toBe(fingerprintStayContext(BASE));
  });
});

describe('fingerprintStayContext() — 敏感性', () => {
  const mutations: Array<[string, StayContext]> = [
    ['supplierHotelId', { ...BASE, supplierHotelId: '90002' }],
    ['checkIn', { ...BASE, checkIn: '2026-11-02' }],
    ['checkOut', { ...BASE, checkOut: '2026-11-04' }],
    ['rooms', { ...BASE, rooms: 2 }],
    ['adults', { ...BASE, adults: 3 }],
    ['childAges', { ...BASE, childAges: [8] }],
    ['currency', { ...BASE, currency: 'CNY' }],
    ['nationality', { ...BASE, nationality: 'JP' }],
  ];

  for (const [field, mutated] of mutations) {
    it(`${field} 变化后指纹不同`, () => {
      expect(fingerprintStayContext(mutated)).not.toBe(fingerprintStayContext(BASE));
    });
  }

  it('夜数不同（整体区间平移）指纹不同', () => {
    const shifted: StayContext = { ...BASE, checkIn: '2026-11-02', checkOut: '2026-11-04' };
    expect(fingerprintStayContext(shifted)).not.toBe(fingerprintStayContext(BASE));
  });
});

describe('isSameStayContext()', () => {
  it('参数一致时为 true', () => {
    expect(isSameStayContext(BASE, { ...BASE })).toBe(true);
  });

  it('关键参数不同时为 false', () => {
    expect(isSameStayContext(BASE, { ...BASE, rooms: 2 })).toBe(false);
    expect(isSameStayContext(BASE, { ...BASE, checkOut: '2026-11-04' })).toBe(false);
  });
});

describe('stayNights() / stayGuests()', () => {
  it('夜数来自入住区间', () => {
    expect(stayNights(BASE)).toBe(2);
  });

  it('住客数 = 成人数 + 儿童数', () => {
    expect(stayGuests(BASE)).toBe(2);
    expect(stayGuests({ ...BASE, adults: 2, childAges: [4, 8] })).toBe(4);
  });
});
