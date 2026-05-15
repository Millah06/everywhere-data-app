import geoip from 'geoip-lite';

interface RegionInfo {
  country: string;
  currency: string;
  timezone: string;
}

/** ISO 3166-1 alpha-2 → ISO 4217 currency. Extend as needed. */
const CURRENCY_MAP: Record<string, string> = {
  NG: 'NGN', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR',
  IT: 'EUR', ES: 'EUR', GH: 'GHS', KE: 'KES', ZA: 'ZAR',
  IN: 'INR', AU: 'AUD', CA: 'CAD', JP: 'JPY', CN: 'CNY',
  AE: 'AED', SA: 'SAR', EG: 'EGP', SN: 'XOF', CM: 'XAF',
  BR: 'BRL', MX: 'MXN', PK: 'PKR', BD: 'BDT', PH: 'PHP',
};

export function detectRegion(req: any): RegionInfo {
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    '127.0.0.1';

  const geo = geoip.lookup(ip);
  const country = geo?.country ?? 'US';
  const timezone = geo?.timezone ?? 'UTC';
  const currency = CURRENCY_MAP[country] ?? 'USD';

  return { country, currency, timezone };
}