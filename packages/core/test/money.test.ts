import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  add,
  decimalsFor,
  equals,
  formatMoney,
  fromDTO,
  isCurrency,
  isNegative,
  isZero,
  money,
  moneyFromMajor,
  multiply,
  percentOf,
  subtract,
  sum,
  toDTO,
  toMajor,
  zero,
} from '../src/money.js';

/**
 * 保护金额真源（money.ts）的三条硬规则：
 *  1. 内部金额永远是「整数最小单位」，非整数必须在入口就炸掉，不能带着浮点往下游流。
 *  2. 零小数币种（JPY/KRW/VND/IDR）的小数位是 0，major/minor 换算不能套用 100。
 *  3. 跨币种运算必须抛错，绝不静默把两种货币加在一起。
 */

describe('decimalsFor — 币种小数位', () => {
  it('零小数币种返回 0 位小数', () => {
    expect(decimalsFor('JPY')).toBe(0);
    expect(decimalsFor('KRW')).toBe(0);
    expect(decimalsFor('VND')).toBe(0);
    expect(decimalsFor('IDR')).toBe(0);
  });

  it('其余币种返回 2 位小数', () => {
    expect(decimalsFor('USD')).toBe(2);
    expect(decimalsFor('CNY')).toBe(2);
    expect(decimalsFor('THB')).toBe(2);
    expect(decimalsFor('EUR')).toBe(2);
  });
});

describe('money() — 整数最小单位入口', () => {
  it('接受整数并原样保存 amount 与 currency', () => {
    const m = money(1234, 'USD');
    expect(m.amount).toBe(1234);
    expect(m.currency).toBe('USD');
  });

  it('拒绝非整数金额并抛 TypeError', () => {
    expect(() => money(12.34, 'USD')).toThrow(TypeError);
    expect(() => money(12.34, 'USD')).toThrow(/integer in minor units/);
  });

  it('拒绝 NaN / Infinity', () => {
    expect(() => money(Number.NaN, 'USD')).toThrow(TypeError);
    expect(() => money(Number.POSITIVE_INFINITY, 'USD')).toThrow(TypeError);
  });

  it('零小数币种同样要求整数', () => {
    expect(() => money(1.5, 'JPY')).toThrow(TypeError);
    expect(money(1500, 'JPY').amount).toBe(1500);
  });

  it('允许负整数（退款场景）', () => {
    expect(money(-500, 'USD').amount).toBe(-500);
  });
});

describe('moneyFromMajor() — 主单位换算', () => {
  it('两位小数币种按 100 放大', () => {
    expect(moneyFromMajor(12.34, 'USD').amount).toBe(1234);
    expect(moneyFromMajor(12.34, 'USD').currency).toBe('USD');
  });

  it('零小数币种不放大', () => {
    expect(moneyFromMajor(1234, 'JPY').amount).toBe(1234);
    expect(moneyFromMajor(1234, 'KRW').amount).toBe(1234);
  });

  it('四舍五入：.5 向上进位', () => {
    expect(moneyFromMajor(0.125, 'USD').amount).toBe(13);
    expect(moneyFromMajor(0.135, 'USD').amount).toBe(14);
  });

  it('负数半值：远离零进位（half-away-from-zero）', () => {
    // Math.round 是 half-up（-12.5 → -12），与 doc 注释的 half-away-from-zero
    // 不符；实现已改为远离零进位，这里锁定修正后的行为。
    expect(moneyFromMajor(-0.125, 'USD').amount).toBe(-13);
  });

  it('消除浮点表示噪声：1.005 美元必须是 101 分', () => {
    // 1.005 * 100 === 100.49999999999999，朴素 Math.round 会少进一分。
    expect(moneyFromMajor(1.005, 'USD').amount).toBe(101);
    expect(moneyFromMajor(1.015, 'USD').amount).toBe(102);
  });
});

describe('toMajor() — 逆向换算', () => {
  it('两位小数币种除以 100', () => {
    expect(toMajor(money(1234, 'USD'))).toBe(12.34);
  });

  it('零小数币种原样返回', () => {
    expect(toMajor(money(1234, 'JPY'))).toBe(1234);
    expect(toMajor(money(0, 'IDR'))).toBe(0);
  });
});

describe('add() / subtract() — 同币种运算', () => {
  it('同币种相加', () => {
    expect(add(money(100, 'USD'), money(250, 'USD')).amount).toBe(350);
  });

  it('同币种相减可得到负数', () => {
    const r = subtract(money(100, 'USD'), money(250, 'USD'));
    expect(r.amount).toBe(-150);
    expect(r.currency).toBe('USD');
  });

  it('跨币种相加抛 TypeError', () => {
    expect(() => add(money(100, 'USD'), money(100, 'JPY'))).toThrow(TypeError);
    expect(() => add(money(100, 'USD'), money(100, 'JPY'))).toThrow(
      /Currency mismatch: USD vs JPY/,
    );
  });

  it('跨币种相减抛 TypeError', () => {
    expect(() => subtract(money(100, 'USD'), money(100, 'CNY'))).toThrow(
      /Currency mismatch: USD vs CNY/,
    );
  });
});

describe('multiply() / percentOf()', () => {
  it('乘以系数并四舍五入到整数', () => {
    expect(multiply(money(1000, 'USD'), 1.5).amount).toBe(1500);
    expect(multiply(money(1000, 'USD'), 1.005).amount).toBe(1005);
    expect(multiply(money(1234, 'JPY'), 2).amount).toBe(2468);
  });

  it('非有限系数抛 TypeError', () => {
    expect(() => multiply(money(100, 'USD'), Number.NaN)).toThrow(TypeError);
    expect(() => multiply(money(100, 'USD'), Number.POSITIVE_INFINITY)).toThrow(
      /Cannot multiply money by Infinity/,
    );
  });

  it('percentOf 按百分比取值', () => {
    expect(percentOf(money(10000, 'USD'), 12).amount).toBe(1200);
    expect(percentOf(money(10000, 'USD'), 0).amount).toBe(0);
    expect(percentOf(money(999, 'USD'), 100).amount).toBe(999);
  });
});

describe('sum() — 列表求和', () => {
  it('求和结果保留币种', () => {
    const r = sum([money(100, 'USD'), money(250, 'USD'), money(50, 'USD')], 'USD');
    expect(r.amount).toBe(400);
    expect(r.currency).toBe('USD');
  });

  it('空列表求和为零', () => {
    const r = sum([], 'USD');
    expect(r.amount).toBe(0);
    expect(r.currency).toBe('USD');
  });

  it('列表币种与目标币种不一致时抛 TypeError', () => {
    expect(() => sum([money(100, 'JPY')], 'USD')).toThrow(TypeError);
  });
});

describe('equals() / isZero() / isNegative()', () => {
  it('equals 同时比较金额与币种', () => {
    expect(equals(money(100, 'USD'), money(100, 'USD'))).toBe(true);
    expect(equals(money(100, 'USD'), money(100, 'JPY'))).toBe(false);
    expect(equals(money(100, 'USD'), money(101, 'USD'))).toBe(false);
  });

  it('isZero / isNegative', () => {
    expect(isZero(zero('USD'))).toBe(true);
    expect(isZero(money(1, 'USD'))).toBe(false);
    expect(isNegative(money(-1, 'USD'))).toBe(true);
    expect(isNegative(zero('USD'))).toBe(false);
  });
});

describe('formatMoney()', () => {
  it('en-US 下美元显示两位小数', () => {
    expect(formatMoney(money(1234, 'USD'), 'en-US')).toBe('$12.34');
    expect(formatMoney(money(0, 'USD'), 'en-US')).toBe('$0.00');
  });

  it('en-US 下零小数币种不显示小数位', () => {
    expect(formatMoney(money(1234, 'JPY'), 'en-US')).toBe('¥1,234');
  });

  it('默认 locale 为 zh-CN', () => {
    expect(formatMoney(money(1234, 'USD'))).toContain('12.34');
  });
});

describe('toDTO() / fromDTO() — 线格式', () => {
  it('toDTO 同时给出整数 amount 与 major', () => {
    expect(toDTO(money(1234, 'USD'))).toEqual({ amount: 1234, currency: 'USD', major: 12.34 });
  });

  it('零小数币种的 major 就是 amount', () => {
    expect(toDTO(money(1234, 'JPY'))).toEqual({ amount: 1234, currency: 'JPY', major: 1234 });
  });

  it('fromDTO 还原为整数最小单位', () => {
    const m = money(1234, 'USD');
    expect(fromDTO(toDTO(m))).toEqual(m);
    expect(fromDTO({ amount: 100, currency: 'USD', major: 1 }).amount).toBe(100);
  });
});

describe('isCurrency() / CURRENCIES', () => {
  it('只认白名单内且大小写敏感的币种', () => {
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('JPY')).toBe(true);
    expect(isCurrency('usd')).toBe(false);
    expect(isCurrency('XXX')).toBe(false);
  });

  it('币种白名单覆盖 18 个币种', () => {
    expect(CURRENCIES.length).toBe(18);
    expect(CURRENCIES).toContain('THB');
    expect(CURRENCIES).toContain('VND');
  });
});
