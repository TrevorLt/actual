import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { app } from '#server/rules/app';
import { loadRules, resetState } from '#server/transactions/transaction-rules';
import type { NewRuleEntity } from '#types/models';

beforeEach(async () => {
  await global.emptyDatabase()();
  resetState();
  await loadMappings();
  await loadRules();
  const groupId = await db.insertCategoryGroup({ name: 'Expenses' });
  await db.insertCategory({
    id: 'subscriptions',
    name: 'Subscriptions',
    cat_group: groupId,
  });
  await db.insertCategory({
    id: 'shopping',
    name: 'Shopping',
    cat_group: groupId,
  });
});

function categoryRule(payeeId: string, categoryId: string): NewRuleEntity {
  return {
    stage: null,
    conditionsOp: 'and',
    conditions: [{ field: 'payee', op: 'is', value: payeeId, type: 'id' }],
    actions: [{ op: 'set', field: 'category', value: categoryId, type: 'id' }],
  };
}

describe('rules app', () => {
  describe('rule-add-batch', () => {
    it('creates one rule per payee in a batch and skips the same rule on retry', async () => {
      const payeeId = await db.insertPayee({ name: 'Streaming service' });
      const candidate = categoryRule(payeeId, 'subscriptions');

      const created = await app.handlers['rule-add-batch']([candidate]);
      expect(created).toMatchObject({
        addedPayeeIds: [payeeId],
        duplicatePayeeIds: [],
        conflictingPayeeIds: [],
        failedPayeeIds: [],
        invalidCount: 0,
      });

      const retried = await app.handlers['rule-add-batch']([candidate]);
      expect(retried).toMatchObject({
        addedPayeeIds: [],
        duplicatePayeeIds: [payeeId],
        conflictingPayeeIds: [],
        failedPayeeIds: [],
      });
      expect((await app.handlers['rules-get']()).length).toBe(1);
    });

    it('does not replace an existing payee category rule with a different category', async () => {
      const payeeId = await db.insertPayee({ name: 'Streaming service' });
      await app.handlers['rule-add'](categoryRule(payeeId, 'shopping'));

      const result = await app.handlers['rule-add-batch']([
        categoryRule(payeeId, 'subscriptions'),
      ]);

      expect(result).toMatchObject({
        addedPayeeIds: [],
        duplicatePayeeIds: [],
        conflictingPayeeIds: [payeeId],
      });
      expect((await app.handlers['rules-get']()).length).toBe(1);
    });

    it('rejects rules outside the simple payee-to-category shape', async () => {
      const payeeId = await db.insertPayee({ name: 'Streaming service' });
      const rule = categoryRule(payeeId, 'subscriptions');
      rule.conditions.push({
        field: 'amount',
        op: 'isapprox',
        value: -1000,
        type: 'number',
      });

      const result = await app.handlers['rule-add-batch']([rule]);

      expect(result).toMatchObject({
        addedPayeeIds: [],
        invalidCount: 1,
      });
      expect((await app.handlers['rules-get']()).length).toBe(0);
    });

    it('rejects categories that do not exist', async () => {
      const payeeId = await db.insertPayee({ name: 'Streaming service' });

      const result = await app.handlers['rule-add-batch']([
        categoryRule(payeeId, 'missing-category'),
      ]);

      expect(result).toMatchObject({
        addedPayeeIds: [],
        invalidCount: 1,
      });
      expect((await app.handlers['rules-get']()).length).toBe(0);
    });
  });
});
