/**
 * Non-destructive end-to-end check for the student lifecycles.
 *
 * Every row this script creates is identified by documentId and removed again,
 * and it asserts that rows which existed beforehand are still present at the end.
 * It never issues a table-wide delete.
 *
 * Run: node scripts/e2e-student-lifecycle.js
 */
const path = require('path');
const Database = require('better-sqlite3');
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const UID = 'api::student.student';
const DB_FILE = path.join(__dirname, '..', '.tmp', 'data.db');

const createdDocumentIds = new Set();
let failures = 0;

const randomDigits = (length) => {
  let digits = String(1 + Math.floor(Math.random() * 9));

  while (digits.length < length) {
    digits += String(Math.floor(Math.random() * 10));
  }

  return digits;
};

const mobileFor = (tag) => `08${tag.slice(0, 8)}`;
const cardIdFor = (tag) => `1${tag}${randomDigits(2)}`;
const maskTail = (value) => `${value.slice(0, value.length - 3)}xxx`;

const rawRow = (documentId) => {
  const db = new Database(DB_FILE, { readonly: true });
  const row = db
    .prepare('select name, mobile, card_id from students where document_id = ?')
    .get(documentId);
  db.close();

  return row ?? null;
};

const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
};

const expectRejected = async (label, run) => {
  try {
    await run();
    check(label, false, 'no error thrown');
  } catch (error) {
    console.log(`  ok   ${label} (${error.message.split('\n')[0]})`);
  }
};

const documentIds = async (strapi) => {
  const rows = await strapi.db.query(UID).findMany({ select: ['documentId'] });

  return rows.map((row) => row.documentId);
};

const trackNew = async (strapi, knownIds) => {
  for (const documentId of await documentIds(strapi)) {
    if (!knownIds.includes(documentId)) {
      createdDocumentIds.add(documentId);
    }
  }
};

const cleanup = async (strapi) => {
  for (const documentId of createdDocumentIds) {
    await strapi.db.query(UID).deleteMany({ where: { documentId } });
  }

  createdDocumentIds.clear();
};

async function main() {
  const appContext = await compileStrapi({ appDir: path.join(__dirname, '..') });
  const strapi = await createStrapi(appContext).load();

  const beforeIds = await documentIds(strapi);

  console.log(`\nstarting with ${beforeIds.length} pre-existing student row(s)`);

  try {
    console.log('\nencode + mask');

    const tag = randomDigits(10);
    const mobile = mobileFor(tag);
    const cardId = cardIdFor(tag);

    const student = await strapi.entityService.create(UID, {
      data: { Name: 'e2e', mobile, CardID: cardId },
    });
    createdDocumentIds.add(student.documentId);

    check(
      'create returns masked values',
      student.mobile === maskTail(mobile) && student.CardID === maskTail(cardId),
      student,
    );

    const stored = rawRow(student.documentId);
    check(
      'sqlite stores b64: for both fields',
      /^b64:/.test(stored.mobile) && /^b64:/.test(stored.card_id),
      stored,
    );

    const formattedTag = randomDigits(10);
    const formattedMobile = mobileFor(formattedTag);
    const formattedCardId = cardIdFor(formattedTag);
    const encoded = (value) => `b64:${Buffer.from(value, 'utf8').toString('base64')}`;

    const formatted = await strapi.entityService.create(UID, {
      data: {
        Name: 'e2e-formatted',
        mobile: `+66 ${formattedMobile.slice(1, 4)}-${formattedMobile.slice(4, 7)}-${formattedMobile.slice(7)}`,
        CardID: `${formattedCardId.slice(0, 4)}-${formattedCardId.slice(4, 9)}-${formattedCardId.slice(9)}`,
      },
    });
    createdDocumentIds.add(formatted.documentId);

    check(
      'formatted input returns normalized masked values',
      formatted.mobile === maskTail(formattedMobile) &&
        formatted.CardID === maskTail(formattedCardId),
      formatted,
    );

    const formattedStored = rawRow(formatted.documentId);
    check(
      'separators and +66 are normalized before encoding',
      formattedStored.mobile === encoded(formattedMobile) &&
        formattedStored.card_id === encoded(formattedCardId),
      formattedStored,
    );

    console.log('\nupdate');

    await strapi.entityService.update(UID, student.id, {
      data: { mobile: maskTail(mobile), CardID: maskTail(cardId) },
    });
    check(
      'masked values never overwrite the stored value',
      rawRow(student.documentId).mobile === stored.mobile &&
        rawRow(student.documentId).card_id === stored.card_id,
    );

    await strapi.entityService.update(UID, student.id, { data: { Name: 'e2e-renamed' } });
    check(
      'partial update leaves encoded columns alone',
      rawRow(student.documentId).mobile === stored.mobile &&
        rawRow(student.documentId).card_id === stored.card_id,
    );

    const newTag = randomDigits(10);
    const newMobile = mobileFor(newTag);
    const newCardId = cardIdFor(newTag);

    const updated = await strapi.entityService.update(UID, student.id, {
      data: { mobile: newMobile, CardID: newCardId },
    });
    check(
      'new values are encoded and masked again',
      updated.mobile === maskTail(newMobile) &&
        updated.CardID === maskTail(newCardId) &&
        rawRow(student.documentId).mobile !== stored.mobile,
      updated,
    );

    console.log('\nbulk');

    const bulkTag = randomDigits(10);
    const bulk = await strapi.db.query(UID).createMany({
      data: [
        { Name: 'e2e-bulk-a', mobile: mobileFor(bulkTag), CardID: cardIdFor(bulkTag) },
        { Name: 'e2e-bulk-b', mobile: mobileFor(randomDigits(10)), CardID: cardIdFor(randomDigits(10)) },
      ],
    });
    await trackNew(strapi, [...beforeIds, student.documentId]);
    check('createMany encodes every row', bulk.count === 2, bulk);

    const bulkRow = await strapi.db.query(UID).findOne({
      where: { Name: 'e2e-bulk-a' },
      select: ['documentId'],
    });
    const bulkStored = rawRow(bulkRow.documentId);
    check(
      'createMany row is stored encoded',
      /^b64:/.test(bulkStored.mobile) && /^b64:/.test(bulkStored.card_id),
      bulkStored,
    );

    const bulkBCardId = cardIdFor(randomDigits(10));
    const updatedCount = await strapi.db.query(UID).updateMany({
      where: { Name: 'e2e-bulk-b' },
      data: { CardID: bulkBCardId },
    });
    check('updateMany encodes its payload', updatedCount.count === 1, updatedCount);

    console.log('\nvalidation');

    await expectRejected('missing CardID', () =>
      strapi.entityService.create(UID, {
        data: { Name: 'e2e-missing', mobile: mobileFor(randomDigits(10)) },
      }),
    );

    await expectRejected('12 digit CardID', () =>
      strapi.entityService.create(UID, {
        data: { Name: 'e2e-short', mobile: mobileFor(randomDigits(10)), CardID: randomDigits(12) },
      }),
    );

    await expectRejected('masked CardID on create', () =>
      strapi.entityService.create(UID, {
        data: {
          Name: 'e2e-masked',
          mobile: mobileFor(randomDigits(10)),
          CardID: maskTail(cardId),
        },
      }),
    );

    await expectRejected('duplicate mobile', () =>
      strapi.entityService.create(UID, {
        data: { Name: 'e2e-dup-mobile', mobile: newMobile, CardID: cardIdFor(randomDigits(10)) },
      }),
    );

    await expectRejected('duplicate CardID', () =>
      strapi.entityService.create(UID, {
        data: { Name: 'e2e-dup-card', mobile: mobileFor(randomDigits(10)), CardID: newCardId },
      }),
    );

    await expectRejected('duplicate inside one createMany payload', () => {
      const sharedCardId = cardIdFor(randomDigits(10));

      return strapi.db.query(UID)
        .createMany({
          data: [
            { Name: 'e2e-payload-a', mobile: mobileFor(randomDigits(10)), CardID: sharedCardId },
            { Name: 'e2e-payload-b', mobile: mobileFor(randomDigits(10)), CardID: sharedCardId },
          ],
        })
        .then(() => Promise.reject(new Error('duplicate CardID was accepted')))
        .catch((error) => {
          if (error.message === 'duplicate CardID was accepted') {
            throw error;
          }

          throw error;
        });
    });

    await expectRejected('update to a taken CardID', () =>
      strapi.entityService.update(UID, student.id, { data: { CardID: bulkBCardId } }),
    );

    await expectRejected('filter on an encoded field', () =>
      strapi.entityService.findMany(UID, { filters: { CardID: cardId } }),
    );

    console.log('\ncleanup');

    await cleanup(strapi);

    const afterIds = await documentIds(strapi);
    const missing = beforeIds.filter((documentId) => !afterIds.includes(documentId));
    check('every pre-existing row survived this run', missing.length === 0, missing);
  } finally {
    await cleanup(strapi);
    await strapi.destroy();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('harness crashed', error);
  process.exit(1);
});
