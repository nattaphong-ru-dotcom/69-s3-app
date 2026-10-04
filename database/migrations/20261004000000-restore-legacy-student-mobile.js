'use strict';

/**
 * The `mobile` field was originally misspelled `Moblie` in schema.json.
 * Strapi's schema sync dropped the old column, which erased every stored
 * mobile number. `forceMigration: false` stops that from happening again, but
 * databases created before this migration still carry the legacy `moblie`
 * column, so copy whatever is left into `mobile` before dropping it.
 *
 * Nothing here encodes or masks: the lifecycle owns that on write, and the read
 * path already masks plain values.
 */
const LEGACY_COLUMN = 'moblie';
const TARGET_COLUMN = 'mobile';
const TABLE = 'students';

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) {
      return;
    }

    if (!(await knex.schema.hasColumn(TABLE, LEGACY_COLUMN))) {
      return;
    }

    if (!(await knex.schema.hasColumn(TABLE, TARGET_COLUMN))) {
      await knex.schema.alterTable(TABLE, (table) => {
        table.string(TARGET_COLUMN, 255);
      });
    }

    const copied = await knex(TABLE)
      .whereNotNull(LEGACY_COLUMN)
      .whereNull(TARGET_COLUMN)
      .update({ [TARGET_COLUMN]: knex.ref(LEGACY_COLUMN) });

    if (copied > 0) {
      console.log(
        `[migration] copied ${copied} "${LEGACY_COLUMN}" value(s) into "${TARGET_COLUMN}". Re-encode them by updating each record.`,
      );
    }
  },

  async down() {
    // Data-preserving one-way migration: nothing to undo.
  },
};
