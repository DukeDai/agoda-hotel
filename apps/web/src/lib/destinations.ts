/**
 * Destinations the inventory actually contains.
 *
 * The value submitted to the API is the Latin city name (that is what the
 * supplier matches on); the label carries the Chinese name for the customer.
 * Kept in a plain module so both server and client components can use it.
 */
export interface DestinationOption {
  value: string;
  label: string;
}

export const DESTINATIONS: DestinationOption[] = [
  { value: 'Phuket', label: '普吉 · Phuket' },
  { value: 'Chiang Mai', label: '清迈 · Chiang Mai' },
  { value: 'Bangkok', label: '曼谷 · Bangkok' },
  { value: 'Ubud', label: '乌布 · Ubud' },
  { value: 'Seminyak', label: '水明漾 · Seminyak' },
  { value: 'Tokyo', label: '东京 · Tokyo' },
  { value: 'Kyoto', label: '京都 · Kyoto' },
  { value: 'Shanghai', label: '上海 · Shanghai' },
  { value: 'Singapore', label: '新加坡 · Singapore' },
  { value: 'Paris', label: '巴黎 · Paris' },
  { value: 'New York', label: '纽约 · New York' },
];
