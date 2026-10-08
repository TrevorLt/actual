import type {
  PayeeEntity,
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { buildPayeeRuleDrafts } from './createRulesForPayees';

function transaction(
  id: string,
  payee: string | null,
  category: string | null,
  overrides: Partial<TransactionEntity> = {},
): TransactionEntity {
  return {
    id,
    account: 'account-1',
    amount: -1000,
    date: '2026-10-01',
    payee,
    ...(category === null ? {} : { category }),
    ...overrides,
  };
}

const payees: PayeeEntity[] = [
  { id: 'streaming', name: 'Streaming service' },
  { id: 'transfer', name: 'Credit card payment', transfer_acct: 'account-2' },
];

describe('buildPayeeRuleDrafts', () => {
  it('groups selected transactions by payee and only proposes one rule for a consistent category', () => {
    const result = buildPayeeRuleDrafts(
      [
        transaction('1', 'streaming', 'subscriptions', {
          imported_payee: 'HULU MONTHLY',
        }),
        transaction('2', 'streaming', 'subscriptions'),
      ],
      payees,
      [],
    );

    expect(result.drafts).toEqual([
      expect.objectContaining({
        payeeId: 'streaming',
        transactionCount: 2,
        usableTransactionCount: 2,
        categoryId: 'subscriptions',
        sampleImportedPayees: ['HULU MONTHLY'],
        status: 'ready',
      }),
    ]);
    expect(result.excludedTransactionCount).toBe(0);
  });

  it('requires review when a payee has transactions in multiple categories', () => {
    const result = buildPayeeRuleDrafts(
      [
        transaction('1', 'streaming', 'subscriptions'),
        transaction('2', 'streaming', 'shopping'),
      ],
      payees,
      [],
    );

    expect(result.drafts[0]).toMatchObject({
      categoryId: null,
      status: 'mixed-categories',
    });
  });

  it('does not duplicate an existing exact category rule', () => {
    const rule: RuleEntity = {
      id: 'rule-1',
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { field: 'payee', op: 'is', value: 'streaming', type: 'id' },
      ],
      actions: [
        { op: 'set', field: 'category', value: 'subscriptions', type: 'id' },
      ],
    };

    const result = buildPayeeRuleDrafts(
      [transaction('1', 'streaming', 'subscriptions')],
      payees,
      [rule],
    );

    expect(result.drafts[0].status).toBe('already-exists');
  });

  it('requires review when another category rule also references the payee', () => {
    const exactRule: RuleEntity = {
      id: 'rule-1',
      stage: null,
      conditionsOp: 'and',
      conditions: [
        { field: 'payee', op: 'is', value: 'streaming', type: 'id' },
      ],
      actions: [
        { op: 'set', field: 'category', value: 'subscriptions', type: 'id' },
      ],
    };
    const otherRule: RuleEntity = {
      ...exactRule,
      id: 'rule-2',
      conditions: [
        { field: 'payee', op: 'oneOf', value: ['streaming'], type: 'id' },
      ],
    };

    const result = buildPayeeRuleDrafts(
      [transaction('1', 'streaming', 'subscriptions')],
      payees,
      [exactRule, otherRule],
    );

    expect(result.drafts[0].status).toBe('conflict');
  });

  it('blocks rules that could conflict with an existing payee category rule', () => {
    const rule: RuleEntity = {
      id: 'rule-1',
      stage: 'post',
      conditionsOp: 'and',
      conditions: [
        { field: 'payee', op: 'is', value: 'streaming', type: 'id' },
      ],
      actions: [
        { op: 'set', field: 'category', value: 'shopping', type: 'id' },
      ],
    };

    const result = buildPayeeRuleDrafts(
      [transaction('1', 'streaming', 'subscriptions')],
      payees,
      [rule],
    );

    expect(result.drafts[0].status).toBe('conflict');
  });

  it('excludes transfers, split transactions, and transactions with no payee', () => {
    const result = buildPayeeRuleDrafts(
      [
        transaction('1', 'transfer', 'subscriptions'),
        transaction('1b', 'streaming', 'subscriptions'),
        transaction('2', 'streaming', 'subscriptions', { is_parent: true }),
        transaction('3', null, 'subscriptions'),
      ],
      payees,
      [],
    );

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.every(draft => draft.status === 'unsupported')).toBe(
      true,
    );
    expect(result.excludedTransactionCount).toBe(4);
  });
});
