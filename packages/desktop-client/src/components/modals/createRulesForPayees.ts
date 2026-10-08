import type {
  PayeeEntity,
  RuleActionEntity,
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

export type PayeeRuleDraftStatus =
  | 'ready'
  | 'already-exists'
  | 'conflict'
  | 'mixed-categories'
  | 'uncategorized'
  | 'unsupported';

export type PayeeRuleDraft = {
  payeeId: string;
  payeeName: string;
  transactionCount: number;
  usableTransactionCount: number;
  categoryCounts: Array<{ categoryId: string | null; count: number }>;
  sampleImportedPayees: string[];
  categoryId: string | null;
  status: PayeeRuleDraftStatus;
};

export type PayeeRuleDrafts = {
  drafts: PayeeRuleDraft[];
  excludedTransactionCount: number;
};

function isCategoryAction(
  action: RuleActionEntity,
): action is Extract<RuleActionEntity, { op: 'set' }> {
  return action.op === 'set' && action.field === 'category';
}

function hasExactCategoryRule(
  rule: RuleEntity,
  payeeId: string,
  categoryId: string,
) {
  const [condition] = rule.conditions;
  const [action] = rule.actions;

  return (
    rule.stage === null &&
    rule.conditionsOp === 'and' &&
    rule.conditions.length === 1 &&
    condition?.field === 'payee' &&
    condition.op === 'is' &&
    condition.value === payeeId &&
    rule.actions.length === 1 &&
    action?.op === 'set' &&
    action.field === 'category' &&
    action.value === categoryId
  );
}

export function buildPayeeRuleDrafts(
  transactions: TransactionEntity[],
  payees: PayeeEntity[],
  rules: RuleEntity[],
): PayeeRuleDrafts {
  const payeesById = new Map(payees.map(payee => [payee.id, payee]));
  const categoryRulesByPayee = new Map<string, RuleEntity[]>();
  for (const rule of rules) {
    if (rule.tombstone || !rule.actions.some(isCategoryAction)) {
      continue;
    }

    const referencedPayeeIds = new Set<string>();
    for (const condition of rule.conditions) {
      if (condition.field === 'payee' && condition.op === 'is') {
        if (typeof condition.value === 'string') {
          referencedPayeeIds.add(condition.value);
        }
      } else if (
        condition.field === 'payee' &&
        condition.op === 'oneOf' &&
        Array.isArray(condition.value)
      ) {
        for (const payeeId of condition.value) {
          if (typeof payeeId === 'string') {
            referencedPayeeIds.add(payeeId);
          }
        }
      }
    }

    for (const payeeId of referencedPayeeIds) {
      const payeeRules = categoryRulesByPayee.get(payeeId) ?? [];
      payeeRules.push(rule);
      categoryRulesByPayee.set(payeeId, payeeRules);
    }
  }
  const grouped = new Map<
    string,
    {
      transactions: TransactionEntity[];
      usableTransactions: TransactionEntity[];
      unsupported: boolean;
      sampleImportedPayees: Set<string>;
    }
  >();
  let excludedTransactionCount = 0;

  for (const transaction of transactions) {
    if (!transaction.payee) {
      excludedTransactionCount++;
      continue;
    }

    const group = grouped.get(transaction.payee) ?? {
      transactions: [],
      usableTransactions: [],
      unsupported: false,
      sampleImportedPayees: new Set<string>(),
    };
    group.transactions.push(transaction);

    const payee = payeesById.get(transaction.payee);
    const isSplit =
      transaction.is_parent ||
      transaction.is_child ||
      (transaction.subtransactions?.length ?? 0) > 0;

    if (!payee || payee.transfer_acct || isSplit) {
      group.unsupported = true;
    } else {
      group.usableTransactions.push(transaction);
    }

    if (transaction.imported_payee) {
      group.sampleImportedPayees.add(transaction.imported_payee);
    }

    grouped.set(transaction.payee, group);
  }

  const drafts = [...grouped.entries()].map(([payeeId, group]) => {
    const payee = payeesById.get(payeeId);
    const categoryCountsById = new Map<string | null, number>();

    for (const transaction of group.usableTransactions) {
      const categoryId = transaction.category ?? null;
      categoryCountsById.set(
        categoryId,
        (categoryCountsById.get(categoryId) ?? 0) + 1,
      );
    }

    const categoryCounts = [...categoryCountsById].map(
      ([categoryId, count]) => ({ categoryId, count }),
    );
    const categoryId =
      categoryCounts.length === 1 && categoryCounts[0].categoryId
        ? categoryCounts[0].categoryId
        : null;

    let status: PayeeRuleDraftStatus;
    if (!payee || payee.transfer_acct || group.unsupported) {
      status = 'unsupported';
    } else if (categoryCounts.length > 1) {
      status = 'mixed-categories';
    } else if (!categoryId) {
      status = 'uncategorized';
    } else {
      const categoryRules = categoryRulesByPayee.get(payeeId) ?? [];

      if (categoryRules.length > 0) {
        status =
          categoryRules.length === 1 &&
          hasExactCategoryRule(categoryRules[0], payeeId, categoryId)
            ? 'already-exists'
            : 'conflict';
      } else {
        status = 'ready';
      }
    }

    return {
      payeeId,
      payeeName: payee?.name ?? payeeId,
      transactionCount: group.transactions.length,
      usableTransactionCount: group.usableTransactions.length,
      categoryCounts,
      sampleImportedPayees: [...group.sampleImportedPayees].slice(0, 3),
      categoryId,
      status,
    } satisfies PayeeRuleDraft;
  });

  excludedTransactionCount += drafts.reduce(
    (count, draft) =>
      count + (draft.status === 'unsupported' ? draft.transactionCount : 0),
    0,
  );

  drafts.sort((a, b) => a.payeeName.localeCompare(b.payeeName));

  return { drafts, excludedTransactionCount };
}
