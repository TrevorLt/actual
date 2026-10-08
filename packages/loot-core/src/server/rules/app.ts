// @ts-strict-ignore
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import * as db from '#server/db';
import { RuleError } from '#server/errors';
import { mutator } from '#server/mutators';
import { batchMessages } from '#server/sync';
import * as rules from '#server/transactions/transaction-rules';
import { undoable } from '#server/undo';
import type {
  NewRuleEntity,
  RuleActionEntity,
  RuleEntity,
  TransactionEntity,
} from '#types/models';

import { Action, Condition, rankRules } from '.';

function validateRule(rule: Partial<RuleEntity>) {
  // Returns an array of errors, the array is the same link as the
  // passed-in `array`, or null if there are no errors
  function runValidation<T>(array: T[], validate: (item: T) => unknown) {
    const result = array.map(item => {
      try {
        validate(item);
      } catch (e) {
        if (e instanceof RuleError) {
          logger.warn('Invalid rule', e);
          return e.type;
        }
        throw e;
      }
      return null;
    });

    return result.filter((res): res is string => typeof res === 'string').length
      ? result
      : null;
  }

  const conditionErrors = runValidation(
    rule.conditions,
    cond => new Condition(cond.op, cond.field, cond.value, cond.options),
  );

  const actionErrors = runValidation(rule.actions, action =>
    action.op === 'delete-transaction'
      ? new Action(action.op, null, null, null)
      : action.op === 'set-split-amount'
        ? new Action(action.op, null, action.value, action.options)
        : action.op === 'link-schedule'
          ? new Action(action.op, null, action.value, null)
          : action.op === 'prepend-notes' || action.op === 'append-notes'
            ? new Action(action.op, null, action.value, null)
            : new Action(action.op, action.field, action.value, action.options),
  );

  if (conditionErrors || actionErrors) {
    return {
      conditionErrors,
      actionErrors,
    };
  }

  return null;
}

type ValidationError = {
  conditionErrors: string[];
  actionErrors: string[];
};

export type RulesHandlers = {
  'rule-validate': typeof ruleValidate;
  'rule-add': typeof addRule;
  'rule-add-batch': typeof addRulesBatch;
  'rule-update': typeof updateRule;
  'rule-delete': typeof deleteRule;
  'rule-delete-all': typeof deleteAllRules;
  'rule-apply-actions': typeof applyRuleActions;
  'rule-add-payee-rename': typeof addRulePayeeRename;
  'rules-get': typeof getRules;
  'rule-get': typeof getRule;
  'rules-run': typeof runRules;
};

// Expose functions to the client
export const app = createApp<RulesHandlers>();

app.method('rule-validate', ruleValidate);
app.method('rule-add', mutator(addRule));
app.method('rule-add-batch', mutator(addRulesBatch));
app.method('rule-update', mutator(undoable(updateRule)));
app.method('rule-delete', mutator(undoable(deleteRule)));
app.method('rule-delete-all', mutator(undoable(deleteAllRules)));
app.method('rule-apply-actions', mutator(undoable(applyRuleActions)));
app.method('rule-add-payee-rename', mutator(addRulePayeeRename));
app.method('rules-get', getRules);
app.method('rule-get', getRule);
app.method('rules-run', runRules);

async function ruleValidate(
  rule: Partial<RuleEntity>,
): Promise<{ error: ValidationError | null }> {
  const error = validateRule(rule);
  return { error };
}

async function addRule(
  rule: Omit<RuleEntity, 'id'>,
): Promise<{ error: ValidationError } | RuleEntity> {
  const error = validateRule(rule);
  if (error) {
    return { error };
  }

  const id = await rules.insertRule(rule);
  return { id, ...rule };
}

type BatchAddRulesResult = {
  addedPayeeIds: string[];
  duplicatePayeeIds: string[];
  conflictingPayeeIds: string[];
  failedPayeeIds: string[];
  invalidCount: number;
};

function getSimplePayeeCategoryRule(rule: NewRuleEntity) {
  const [condition] = rule.conditions;
  const [action] = rule.actions;

  if (
    rule.stage !== null ||
    rule.conditionsOp !== 'and' ||
    rule.conditions.length !== 1 ||
    condition?.field !== 'payee' ||
    condition.op !== 'is' ||
    typeof condition.value !== 'string' ||
    rule.actions.length !== 1 ||
    action?.op !== 'set' ||
    action.field !== 'category' ||
    typeof action.value !== 'string'
  ) {
    return null;
  }

  return { payeeId: condition.value, categoryId: action.value };
}

function isExactPayeeCategoryRule(
  rule: RuleEntity,
  payeeId: string,
  categoryId: string,
) {
  const simpleRule = getSimplePayeeCategoryRule(rule);
  return (
    simpleRule?.payeeId === payeeId && simpleRule.categoryId === categoryId
  );
}

async function addRulesBatch(
  candidates: NewRuleEntity[],
): Promise<BatchAddRulesResult> {
  const result: BatchAddRulesResult = {
    addedPayeeIds: [],
    duplicatePayeeIds: [],
    conflictingPayeeIds: [],
    failedPayeeIds: [],
    invalidCount: 0,
  };
  const seen = new Map<string, string>();
  const currentRules = rules.getRules().filter(rule => !rule.tombstone);
  const [payees, categories] = await Promise.all([
    db.getPayees(),
    db.getCategories(),
  ]);
  const payeesById = new Map(payees.map(payee => [payee.id, payee]));
  const categoryIds = new Set(categories.map(category => category.id));
  const existingCategoryRulesByPayee = new Map<string, RuleEntity[]>();
  for (const rule of currentRules) {
    if (
      !rule.actions.some(
        action => action.op === 'set' && action.field === 'category',
      )
    ) {
      continue;
    }

    const payeeIds = new Set<string>();
    for (const condition of rule.conditions) {
      if (condition.field !== 'payee') {
        continue;
      }

      if (condition.op === 'is' && typeof condition.value === 'string') {
        payeeIds.add(condition.value);
      } else if (condition.op === 'oneOf' && Array.isArray(condition.value)) {
        for (const payeeId of condition.value) {
          if (typeof payeeId === 'string') {
            payeeIds.add(payeeId);
          }
        }
      }
    }

    for (const payeeId of payeeIds) {
      const matchingRules = existingCategoryRulesByPayee.get(payeeId) ?? [];
      matchingRules.push(rule);
      existingCategoryRulesByPayee.set(payeeId, matchingRules);
    }
  }
  const rulesToAdd: Array<{
    payeeId: string;
    categoryId: string;
    rule: NewRuleEntity;
  }> = [];

  for (const candidate of candidates) {
    const simpleRule = getSimplePayeeCategoryRule(candidate);
    if (!simpleRule || validateRule(candidate)) {
      if (simpleRule) {
        result.failedPayeeIds.push(simpleRule.payeeId);
      } else {
        result.invalidCount++;
      }
      continue;
    }

    const { payeeId, categoryId } = simpleRule;
    const payee = payeesById.get(payeeId);
    if (!payee || payee.transfer_acct || !categoryIds.has(categoryId)) {
      result.invalidCount++;
      continue;
    }

    const previousCategoryId = seen.get(payeeId);
    if (seen.has(payeeId)) {
      if (previousCategoryId === categoryId) {
        result.duplicatePayeeIds.push(payeeId);
      } else {
        result.conflictingPayeeIds.push(payeeId);
      }
      continue;
    }
    seen.set(payeeId, categoryId);

    const existingCategoryRules =
      existingCategoryRulesByPayee.get(payeeId) ?? [];

    if (existingCategoryRules.length > 0) {
      if (
        existingCategoryRules.length === 1 &&
        isExactPayeeCategoryRule(existingCategoryRules[0], payeeId, categoryId)
      ) {
        result.duplicatePayeeIds.push(payeeId);
      } else {
        result.conflictingPayeeIds.push(payeeId);
      }
      continue;
    }

    rulesToAdd.push({ payeeId, categoryId, rule: candidate });
  }

  await batchMessages(async () => {
    for (const candidate of rulesToAdd) {
      try {
        const addedRule = await addRule(candidate.rule);
        if ('error' in addedRule) {
          result.failedPayeeIds.push(candidate.payeeId);
        } else {
          result.addedPayeeIds.push(candidate.payeeId);
        }
      } catch (error) {
        logger.warn('Failed to add rule in bulk', error);
        result.failedPayeeIds.push(candidate.payeeId);
      }
    }
  });

  return result;
}

async function updateRule(
  rule: RuleEntity,
): Promise<{ error: ValidationError } | RuleEntity> {
  const error = validateRule(rule);
  if (error) {
    return { error };
  }

  await rules.updateRule(rule);
  return rule;
}

async function deleteRule(id: RuleEntity['id']) {
  return rules.deleteRule(id);
}

async function deleteAllRules(
  ids: Array<RuleEntity['id']>,
): Promise<{ someDeletionsFailed: boolean }> {
  let someDeletionsFailed = false;

  await batchMessages(async () => {
    for (const id of ids) {
      const res = await rules.deleteRule(id);
      if (res === false) {
        someDeletionsFailed = true;
      }
    }
  });

  return { someDeletionsFailed };
}

async function applyRuleActions({
  transactions,
  actions,
}: {
  transactions: TransactionEntity[];
  actions: Array<Action | RuleActionEntity>;
}): Promise<null | {
  added: TransactionEntity[];
  updated: unknown[];
  errors: string[];
}> {
  return rules.applyActions(transactions, actions);
}

async function addRulePayeeRename({
  fromNames,
  to,
}: {
  fromNames: string[];
  to: string;
}): Promise<string> {
  return rules.updatePayeeRenameRule(fromNames, to);
}

async function getRule({
  id,
}: {
  id: RuleEntity['id'];
}): Promise<RuleEntity | null> {
  const rule = rules.getRules().find(rule => rule.id === id);
  return rule ? rule.serialize() : null;
}

async function getRules() {
  return rankRules(rules.getRules()).map(rule => rule.serialize());
}

async function runRules({
  transaction,
}: {
  transaction: TransactionEntity;
}): Promise<TransactionEntity> {
  return rules.runRules(transaction);
}
