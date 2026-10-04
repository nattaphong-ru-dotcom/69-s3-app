const STORAGE_PREFIX = 'b64:';
const MASK_LENGTH = 3;
const MASK_PATTERN = /^[+0-9]*[xX*•]{3}$/;
const SEPARATOR_PATTERN = /[\s\-().]/g;
const LEADING_PLUS_PATTERN = /^\+/;

const DIGITS_PATTERN = /^[0-9]{9,15}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const INTERNATIONAL_PREFIX = '+66';
const LOCAL_PHONE_LENGTH = 10;

export function stripSeparators(value: string): string {
  return value.trim().replace(SEPARATOR_PATTERN, '');
}

export function normalizeDigits(value: string): string {
  return stripSeparators(value).replace(LEADING_PLUS_PATTERN, '');
}

export function normalizePhone(value: string): string {
  const cleaned = stripSeparators(value);

  if (cleaned.startsWith('00')) {
    return `+${cleaned.slice(2)}`;
  }

  if (
    cleaned.startsWith(INTERNATIONAL_PREFIX) &&
    cleaned.length === INTERNATIONAL_PREFIX.length + LOCAL_PHONE_LENGTH - 1
  ) {
    return `0${cleaned.slice(INTERNATIONAL_PREFIX.length)}`;
  }

  return cleaned;
}

export function isMaskedValue(value: string): boolean {
  return MASK_PATTERN.test(value);
}

export function maskTail(value: string): string {
  return `${value.slice(0, -MASK_LENGTH)}${'x'.repeat(MASK_LENGTH)}`;
}

export function encodeValue(plain: string): string {
  return `${STORAGE_PREFIX}${Buffer.from(plain, 'utf8').toString('base64')}`;
}

function isCanonicalBase64(value: string): boolean {
  if (!BASE64_PATTERN.test(value) || value.length % 4 !== 0) {
    return false;
  }

  return Buffer.from(value, 'base64').toString('base64') === value;
}

function fromEncodedPayload(payload: string): string | null {
  if (!isCanonicalBase64(payload)) {
    return null;
  }

  const decoded = Buffer.from(payload, 'base64').toString('utf8');

  return DIGITS_PATTERN.test(decoded) ? decoded : null;
}

function fromStoredValue(value: string): string | null {
  if (value.startsWith(STORAGE_PREFIX)) {
    return fromEncodedPayload(value.slice(STORAGE_PREFIX.length));
  }

  return fromEncodedPayload(value) ?? (DIGITS_PATTERN.test(value) ? value : null);
}

export function decodeValue(stored: unknown): string | null {
  if (typeof stored !== 'string' || stored === '' || isMaskedValue(stored)) {
    return null;
  }

  return fromStoredValue(stored);
}

export function maskStoredValue(stored: unknown): string | null {
  if (typeof stored !== 'string' || stored === '') {
    return null;
  }

  const value = fromStoredValue(stored);

  if (value !== null) {
    return maskTail(value);
  }

  return isMaskedValue(stored) ? stored : null;
}