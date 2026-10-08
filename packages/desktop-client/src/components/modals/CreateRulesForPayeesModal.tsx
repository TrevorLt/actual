import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { ungroupTransactions } from '@actual-app/core/shared/transactions';
import type {
  NewRuleEntity,
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { Information } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { Checkbox } from '#components/forms';
import { useCategories } from '#hooks/useCategories';
import { usePayees } from '#hooks/usePayees';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { aqlQuery } from '#queries/aqlQuery';

import { buildPayeeRuleDrafts } from './createRulesForPayees';
import type { PayeeRuleDraft } from './createRulesForPayees';

type CreateRulesForPayeesModalProps = Extract<
  ModalType,
  { name: 'create-rules-for-payees' }
>['options'];

type LoadedData = {
  transactions: TransactionEntity[];
  rules: RuleEntity[];
};

type BatchAddRulesResult = {
  addedPayeeIds: string[];
  duplicatePayeeIds: string[];
  conflictingPayeeIds: string[];
  failedPayeeIds: string[];
  invalidCount: number;
};

const statusTranslationKeys: Record<PayeeRuleDraft['status'], string> = {
  ready: 'Ready to create',
  'already-exists': 'Matching rule already exists',
  conflict: 'Review existing rule',
  'mixed-categories': 'Selected transactions have multiple categories',
  uncategorized: 'Selected transactions are uncategorized',
  unsupported: 'Split or transfer transactions need review',
};

export function CreateRulesForPayeesModal({
  transactionIds,
}: CreateRulesForPayeesModalProps) {
  const { t } = useTranslation();
  const { data: payees = [], isLoading: payeesLoading } = usePayees();
  const {
    data: { list: categories = [] } = { list: [], grouped: [] },
    isLoading: categoriesLoading,
  } = useCategories();
  const [loadedData, setLoadedData] = useState<LoadedData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedPayeeIds, setSelectedPayeeIds] = useState<Set<string>>(
    new Set(),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<BatchAddRulesResult | null>(
    null,
  );
  const [saveError, setSaveError] = useState(false);
  const transactionIdsKey = transactionIds.join('\u0000');

  useEffect(() => {
    let cancelled = false;
    setLoadedData(null);
    setLoadError(false);
    setSaveResult(null);
    setSaveError(false);

    const ids = [...new Set(transactionIdsKey.split('\u0000').filter(Boolean))];
    const idChunks = Array.from(
      { length: Math.ceil(ids.length / 500) },
      (_, i) => ids.slice(i * 500, (i + 1) * 500),
    );
    void Promise.all([
      Promise.all(
        idChunks.map(chunk =>
          aqlQuery(
            q('transactions')
              .filter({ id: { $oneof: chunk } })
              .select('*')
              .options({ splits: 'grouped' }),
          ),
        ),
      ),
      send('rules-get'),
    ])
      .then(([results, rules]) => {
        if (!cancelled) {
          setLoadedData({
            transactions: ungroupTransactions(
              results.flatMap(({ data }) => data),
            ),
            rules,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transactionIdsKey]);

  const payeeRuleDrafts = useMemo(() => {
    if (!loadedData || payeesLoading || categoriesLoading) {
      return null;
    }

    return buildPayeeRuleDrafts(
      loadedData.transactions,
      payees,
      loadedData.rules,
    );
  }, [loadedData, payees, payeesLoading, categoriesLoading]);

  useEffect(() => {
    if (payeeRuleDrafts) {
      setSelectedPayeeIds(
        new Set(
          payeeRuleDrafts.drafts
            .filter(draft => draft.status === 'ready')
            .map(draft => draft.payeeId),
        ),
      );
    }
  }, [payeeRuleDrafts]);

  const categoryNamesById = useMemo(
    () => new Map(categories.map(category => [category.id, category.name])),
    [categories],
  );

  const selectedDrafts =
    payeeRuleDrafts?.drafts.filter(
      draft => draft.status === 'ready' && selectedPayeeIds.has(draft.payeeId),
    ) ?? [];

  const onCreateRules = async () => {
    if (!payeeRuleDrafts || selectedDrafts.length === 0) {
      return;
    }

    const rulesToCreate: NewRuleEntity[] = selectedDrafts.map(draft => ({
      stage: null,
      conditionsOp: 'and',
      conditions: [
        {
          field: 'payee',
          op: 'is',
          value: draft.payeeId,
          type: 'id',
        },
      ],
      actions: [
        {
          op: 'set',
          field: 'category',
          value: draft.categoryId,
          type: 'id',
        },
      ],
    }));

    setIsSaving(true);
    setSaveError(false);

    try {
      const result = await send('rule-add-batch', rulesToCreate);
      setSaveResult(result);
      const rules = await send('rules-get');
      if (loadedData) {
        setLoadedData({ transactions: loadedData.transactions, rules });
      }
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  };

  const isLoading =
    (!loadedData && !loadError) ||
    payeesLoading ||
    categoriesLoading ||
    isSaving;

  return (
    <Modal
      name="create-rules-for-payees"
      isLoading={isLoading}
      containerProps={{
        style: {
          width: 980,
          minWidth: 'min(90vw, 980px)',
          maxWidth: '90vw',
        },
      }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Create rules for payees')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          <View style={{ gap: 12, marginTop: 12 }}>
            <Information>
              <Trans>
                Rules created here apply to future imported transactions. The
                selected transactions will not be changed. Other matching rules,
                such as imported payee rules, may still run as well.
              </Trans>
            </Information>

            {loadError ? (
              <Text style={{ color: theme.errorText }}>
                <Trans>
                  Could not load the selected transactions or rules.
                </Trans>
              </Text>
            ) : null}

            {payeeRuleDrafts ? (
              <>
                <Text>
                  <Trans>
                    Review one rule per payee. Only payees with a single,
                    consistent category and no existing category rule are
                    selected by default.
                  </Trans>
                </Text>

                {payeeRuleDrafts.excludedTransactionCount > 0 ? (
                  <Text style={{ color: theme.pageTextSubdued }}>
                    {t(
                      '{{count}} selected transactions need review and will not be used.',
                      {
                        count: payeeRuleDrafts.excludedTransactionCount,
                      },
                    )}
                  </Text>
                ) : null}

                <View
                  role="list"
                  aria-label={t('Payees and proposed rules')}
                  style={{
                    border: `1px solid ${theme.tableBorder}`,
                    borderRadius: 6,
                    maxHeight: '55vh',
                    overflowY: 'auto',
                  }}
                >
                  {payeeRuleDrafts.drafts.map(draft => {
                    const isReady = draft.status === 'ready';
                    const categoriesSummary = draft.categoryCounts
                      .map(({ categoryId, count }) =>
                        t('{{category}} ({{count}})', {
                          category:
                            categoryId === null
                              ? t('Uncategorized')
                              : (categoryNamesById.get(categoryId) ??
                                t('Unknown category')),
                          count,
                        }),
                      )
                      .join(', ');

                    return (
                      <View
                        key={draft.payeeId}
                        role="listitem"
                        style={{
                          flexDirection: 'row',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: 10,
                          borderBottom: `1px solid ${theme.tableBorder}`,
                          backgroundColor: theme.tableBackground,
                        }}
                      >
                        <Checkbox
                          aria-label={t('Create a rule for {{payee}}', {
                            payee: draft.payeeName,
                          })}
                          checked={selectedPayeeIds.has(draft.payeeId)}
                          disabled={!isReady || isSaving}
                          onChange={event => {
                            setSelectedPayeeIds(current => {
                              const next = new Set(current);
                              if (event.target.checked) {
                                next.add(draft.payeeId);
                              } else {
                                next.delete(draft.payeeId);
                              }
                              return next;
                            });
                          }}
                        />
                        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                          <View
                            style={{
                              flexDirection: 'row',
                              justifyContent: 'space-between',
                              gap: 10,
                              flexWrap: 'wrap',
                            }}
                          >
                            <Text style={{ fontWeight: 700 }}>
                              {draft.payeeName} ·{' '}
                              {t('{{count}} transactions', {
                                count: draft.transactionCount,
                              })}
                            </Text>
                            <Text
                              style={{
                                color:
                                  draft.status === 'ready'
                                    ? theme.pageTextPositive
                                    : theme.pageTextSubdued,
                              }}
                            >
                              {t(statusTranslationKeys[draft.status])}
                            </Text>
                          </View>
                          <Text
                            size="small"
                            style={{ color: theme.pageTextSubdued }}
                          >
                            {t('Selected categories: {{categories}}', {
                              categories: categoriesSummary || t('None'),
                            })}
                          </Text>
                          {draft.sampleImportedPayees.length > 0 ? (
                            <Text
                              size="small"
                              style={{ color: theme.pageTextSubdued }}
                            >
                              {t('Imported payee examples: {{payees}}', {
                                payees: draft.sampleImportedPayees.join(', '),
                              })}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View>

                {payeeRuleDrafts.drafts.length === 0 ? (
                  <Text>
                    <Trans>
                      No payees were found in the selected transactions.
                    </Trans>
                  </Text>
                ) : null}
              </>
            ) : null}

            {saveResult ? (
              <Text role="status">
                {t(
                  'Created {{added}} rules; {{duplicates}} already existed; {{conflicts}} need review; {{failed}} failed.',
                  {
                    added: saveResult.addedPayeeIds.length,
                    duplicates: saveResult.duplicatePayeeIds.length,
                    conflicts: saveResult.conflictingPayeeIds.length,
                    failed:
                      saveResult.failedPayeeIds.length +
                      saveResult.invalidCount,
                  },
                )}
              </Text>
            ) : null}

            {saveError ? (
              <Text role="alert" style={{ color: theme.errorText }}>
                <Trans>
                  Could not finish creating rules. Review the Rules page before
                  retrying.
                </Trans>
              </Text>
            ) : null}

            <ModalButtons style={{ marginTop: 10 }}>
              <Button onPress={() => state.close()}>
                <Trans>Close</Trans>
              </Button>
              <Button
                variant="primary"
                isDisabled={
                  selectedDrafts.length === 0 || isSaving || !!loadError
                }
                onPress={() => void onCreateRules()}
              >
                {t('Create {{count}} rules', { count: selectedDrafts.length })}
              </Button>
            </ModalButtons>
          </View>
        </>
      )}
    </Modal>
  );
}
