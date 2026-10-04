import type { Event } from '@strapi/database';

import {
  encodeValue,
  isMaskedValue,
  maskStoredValue,
  normalizeDigits,
  normalizePhone,
} from '../../../../utils/field-codec';

type EncodedField = {
  name: string;
  label: string;
  length: number;
  pattern: RegExp;
  normalize: (value: string) => string;
};

const ENCODED_FIELDS: EncodedField[] = [
  {
    name: 'mobile',
    label: 'mobile number',
    length: 10,
    pattern: /^[0-9]{10}$/,
    normalize: normalizePhone,
  },
  {
    name: 'CardID',
    label: 'card id',
    length: 13,
    pattern: /^[0-9]{13}$/,
    normalize: normalizeDigits,
  },
];

const ENCODED_FIELD_NAMES = ENCODED_FIELDS.map((field) => field.name);

type DataRecord = Record<string, unknown>;

type WriteMode = 'create' | 'update';

const internalLookups = new WeakSet<object>();

function isInternalLookup(event: Event): boolean {
  return internalLookups.has(event.params as unknown as object);
}

function asRecord(value: unknown): DataRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as DataRecord;
}

function describeRecord(record: DataRecord): string {
  const id = record.documentId ?? record.id;

  return id === undefined || id === null ? 'unknown' : String(id);
}

function canonicalDigits(field: EncodedField, value: unknown, mode: WriteMode): string {
  const action = mode === 'create' ? 'creating' : 'updating';

  if (typeof value !== 'string') {
    throw new Error(
      `"${field.name}" must be a string of ${field.length} digits when ${action} a student. Received: ${String(value)}.`,
    );
  }

  const digits = field.normalize(value);

  if (!field.pattern.test(digits)) {
    throw new Error(
      `"${field.name}" must be exactly ${field.length} digits when ${action} a student. Received: "${value}".`,
    );
  }

  return digits;
}

function encodeField(field: EncodedField, record: DataRecord, mode: WriteMode): void {
  const required = mode === 'create';

  if (!(field.name in record)) {
    if (required) {
      throw new Error(`"${field.name}" is required when creating a student.`);
    }

    return;
  }

  const incoming = record[field.name];

  if (typeof incoming === 'string' && isMaskedValue(incoming)) {
    if (required) {
      throw new Error(
        `"${field.name}" cannot be submitted as a masked ${field.label} when creating a student.`,
      );
    }

    delete record[field.name];

    return;
  }

  record[field.name] = encodeValue(canonicalDigits(field, incoming, mode));
}

function encodeRecord(data: unknown, mode: WriteMode): void {
  const record = asRecord(data);

  if (!record) {
    if (mode === 'create') {
      throw new Error('Creating a student requires a data object.');
    }

    return;
  }

  ENCODED_FIELDS.forEach((field) => encodeField(field, record, mode));
}

function encodePayload(data: unknown, mode: WriteMode): void {
  if (Array.isArray(data)) {
    data.forEach((entry) => encodeRecord(entry, mode));

    return;
  }

  encodeRecord(data, mode);
}

function isSameEntity(row: DataRecord, where: unknown): boolean {
  const filter = asRecord(where);

  if (!filter) {
    return false;
  }

  if (typeof filter.id === 'number' && row.id === filter.id) {
    return true;
  }

  return typeof filter.documentId === 'string' && row.documentId === filter.documentId;
}

async function findRowsWithEncodedValue(
  event: Event,
  field: EncodedField,
  encoded: string,
): Promise<DataRecord[]> {
  const uid = (event.model as { uid?: string } | undefined)?.uid;

  if (!uid) {
    return [];
  }

  const params = { where: { [field.name]: encoded }, select: ['id', 'documentId'] };

  internalLookups.add(params);

  const rows = await strapi.db.query(uid).findMany(params);

  return Array.isArray(rows) ? (rows as DataRecord[]) : [];
}

async function assertUniqueValues(event: Event): Promise<void> {
  const pending = new Set<string>();
  const payloads = Array.isArray(event.params.data) ? event.params.data : [event.params.data];

  for (const payload of payloads) {
    const record = asRecord(payload);

    if (!record) {
      continue;
    }

    for (const field of ENCODED_FIELDS) {
      const encoded = record[field.name];

      if (typeof encoded !== 'string') {
        continue;
      }

      const key = `${field.name}=${encoded}`;

      if (pending.has(key)) {
        throw new Error(`"${field.name}" must be unique; the same value was submitted twice.`);
      }

      const rows = await findRowsWithEncodedValue(event, field, encoded);

      if (rows.some((row) => !isSameEntity(row, event.params.where))) {
        throw new Error(
          `"${field.name}" must be unique; another student already uses that ${field.label}.`,
        );
      }

      pending.add(key);
    }
  }
}

function filterNodes(event: Event): unknown[] {
  const params = event.params as unknown as DataRecord;

  return [params.where, params.filters];
}

function collectEncodedFilterFields(node: unknown, found: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectEncodedFilterFields(entry, found));

    return found;
  }

  const filter = asRecord(node);

  if (!filter) {
    return found;
  }

  Object.entries(filter).forEach(([key, value]) => {
    if (ENCODED_FIELD_NAMES.includes(key) && !found.includes(key)) {
      found.push(key);
    }

    collectEncodedFilterFields(value, found);
  });

  return found;
}

function encodedFilterFields(event: Event): string[] {
  return filterNodes(event).reduce<string[]>(
    (found, node) => collectEncodedFilterFields(node, found),
    [],
  );
}

function assertNoEncodedFilter(event: Event, action: string): void {
  if (isInternalLookup(event)) {
    return;
  }

  const [field] = encodedFilterFields(event);

  if (field) {
    throw new Error(
      `Cannot filter students by "${field}" while ${action}: the stored value is encoded, so the comparison never matches. Fetch the students and compare the decoded value instead.`,
    );
  }
}

function warnOnEncodedFilter(event: Event, action: string): void {
  if (isInternalLookup(event)) {
    return;
  }

  const fields = encodedFilterFields(event);

  if (fields.length === 0) {
    return;
  }

  strapi.log.warn(
    `[student] A query filtered by "${fields.join('", "')}" while ${action}; it cannot match the encoded value. This also happens internally because the unique-field check queries every unique attribute.`,
  );
}

function maskRecord(record: DataRecord): void {
  ENCODED_FIELDS.forEach((field) => {
    if (!(field.name in record)) {
      return;
    }

    const stored = record[field.name];
    const masked = maskStoredValue(stored);

    if (masked === null) {
      if (stored !== null && stored !== undefined && stored !== '') {
        strapi.log.warn(
          `[student] Could not decode "${field.name}" for document ${describeRecord(record)}; the stored value is not a known encoding.`,
        );
      }

      record[field.name] = null;

      return;
    }

    record[field.name] = masked;
  });
}

function maskTree(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => maskTree(entry));

    return;
  }

  const record = asRecord(node);

  if (!record) {
    return;
  }

  maskRecord(record);

  Object.values(record).forEach((value) => maskTree(value));
}

export default {
  async beforeCreate(event: Event) {
    encodeRecord(event.params.data, 'create');
    await assertUniqueValues(event);
  },

  afterCreate(event: Event) {
    maskTree(event.result);
  },

  async beforeCreateMany(event: Event) {
    encodePayload(event.params.data, 'create');
    await assertUniqueValues(event);
  },

  afterCreateMany(event: Event) {
    strapi.log.info(
      `[student] Encoded ${event.params.data?.length ?? 0} student record(s) on bulk create.`,
    );
  },

  beforeFindOne(event: Event) {
    warnOnEncodedFilter(event, 'finding one student');
  },

  afterFindOne(event: Event) {
    maskTree(event.result);
  },

  beforeFindMany(event: Event) {
    assertNoEncodedFilter(event, 'listing students');
  },

  afterFindMany(event: Event) {
    maskTree(event.result);
  },

  beforeCount(event: Event) {
    assertNoEncodedFilter(event, 'counting students');
  },

  afterCount() {},

  async beforeUpdate(event: Event) {
    encodeRecord(event.params.data, 'update');
    await assertUniqueValues(event);
  },

  afterUpdate(event: Event) {
    maskTree(event.result);
  },

  beforeUpdateMany(event: Event) {
    encodePayload(event.params.data, 'update');
  },

  afterUpdateMany(event: Event) {
    const record = asRecord(event.result);

    strapi.log.info(
      `[student] Encoded ${record?.count ?? 0} student record(s) on bulk update.`,
    );
  },

  beforeDelete(event: Event) {
    assertNoEncodedFilter(event, 'deleting a student');
  },

  afterDelete(event: Event) {
    const record = asRecord(event.result);

    strapi.log.info(`[student] Deleted student ${record ? describeRecord(record) : 'unknown'}.`);
    maskTree(event.result);
  },

  beforeDeleteMany(event: Event) {
    assertNoEncodedFilter(event, 'bulk deleting students');
  },

  afterDeleteMany(event: Event) {
    const record = asRecord(event.result);

    strapi.log.warn(
      `[student] Bulk deleted ${record?.count ?? 0} student(s); their encoded ${ENCODED_FIELDS.map((field) => field.name).join(' and ')} values are gone.`,
    );
  },
};