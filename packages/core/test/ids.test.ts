import { afterEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, newId, newOrderNo, newUuid, stableStringify } from '../src/ids.js';

/**
 * 保护 id 生成器（ids.ts）的规则：
 *  1. ULID 按时间字典序单调——排序 id 等于排序创建时间，索引才不会随机分裂。
 *  2. id 必须唯一，前缀只做人类可读标记，不影响唯一性。
 *  3. fingerprint 必须稳定（键序无关）且敏感（值变即变），它是参数漂移的证据。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = new RegExp(`^[${CROCKFORD}]{26}$`);
const HEX64 = /^[0-9a-f]{64}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

/** 解 ULID 的前 10 位时间前缀（Crockford base32）回毫秒时间戳。 */
function decodeUlidTime(ulid: string): number {
  let t = 0;
  for (const ch of ulid.slice(0, 10)) {
    t = t * 32 + CROCKFORD.indexOf(ch);
  }
  return t;
}

describe('newId() — ULID 形状', () => {
  it('无前缀时是 26 位 Crockford base32', () => {
    const id = newId();
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID_RE);
  });

  it('带前缀时前缀 + 下划线 + 26 位 ULID', () => {
    const id = newId('ord');
    expect(id.startsWith('ord_')).toBe(true);
    expect(id.slice('ord_'.length)).toMatch(ULID_RE);
  });
});

describe('newId() — 唯一性', () => {
  it('2000 个 id 互不相同', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      ids.add(newId());
    }
    expect(ids.size).toBe(2000);
  });
});

describe('newId() — 单调性', () => {
  it('时间前缀就是生成时刻的毫秒时间戳', () => {
    const t = Date.parse('2026-10-20T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(t);
    const id = newId();
    expect(decodeUlidTime(id)).toBe(t);
    // 2026-10-20T00:00:00.000Z 的 base32 时间前缀固定为 01M5B9Q600
    expect(id.slice(0, 10)).toBe('01M5B9Q600');
  });

  it('时间前进时 id 严格变大（字典序）', () => {
    const t0 = Date.parse('2026-10-20T00:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const first = newId();

    now.mockReturnValue(t0 + 1);
    const second = newId();

    now.mockReturnValue(t0 + 1000);
    const third = newId();

    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
  });
});

describe('newUuid()', () => {
  it('是 v4 格式的 UUID', () => {
    expect(newUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('连续调用互不相同', () => {
    expect(new Set([newUuid(), newUuid(), newUuid()]).size).toBe(3);
  });
});

describe('newOrderNo() — 订单号', () => {
  it('格式为 OTA-YYYYMMDD-6位Crockford', () => {
    const no = newOrderNo(new Date('2026-10-20T12:34:56.000Z'));
    expect(no).toMatch(new RegExp(`^OTA-20261020-[${CROCKFORD}]{6}$`));
  });

  it('同一天内订单号互不相同', () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    const nos = new Set([newOrderNo(now), newOrderNo(now), newOrderNo(now)]);
    expect(nos.size).toBe(3);
  });

  it('跨月跨年日期前缀不同', () => {
    expect(newOrderNo(new Date('2026-01-05T00:00:00.000Z'))).toMatch(/^OTA-20260105-/);
    expect(newOrderNo(new Date('2026-12-31T00:00:00.000Z'))).toMatch(/^OTA-20261231-/);
  });
});

describe('fingerprint() — SHA-256 指纹', () => {
  it('是 64 位小写十六进制', () => {
    expect(fingerprint({ a: 1 })).toMatch(HEX64);
    expect(fingerprint({ a: 1 })).toHaveLength(64);
  });

  it('同值同指纹（稳定）', () => {
    expect(fingerprint({ a: 1, b: 'x' })).toBe(fingerprint({ a: 1, b: 'x' }));
  });

  it('键序不同指纹相同', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('值变化指纹不同（敏感）', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: '1' }));
  });
});

describe('stableStringify() — 稳定序列化', () => {
  it('对象键按字典序输出', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('undefined 字段被丢弃', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('数组保持原有顺序', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('嵌套对象同样按键排序', () => {
    expect(stableStringify({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it('原始值直接序列化', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(true)).toBe('true');
  });
});
