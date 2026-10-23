import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/api/models.dart';

import 'affordability_fixture.dart';

void main() {
  test('reads money as minor-unit strings', () {
    final summary = HomeSummary.fromJson({
      'period': {'label': 'September 2026', 'from': '2026-08-31T23:00:00.000Z', 'to': '2026-09-30T23:00:00.000Z'},
      'incomeMinor': '198361100',
      'expensesMinor': '42370050',
      'netMinor': '155991050',
      'balanceMinor': '450000000',
      'balanceCurrency': 'NGN',
      'count': 7,
      'spendingByCategory': [
        {'category': 'Food', 'totalMinor': '1845000', 'count': 1},
      ],
      'recent': [_tx],
    });
    expect(summary.periodLabel, 'September 2026');
    expect(summary.incomeMinor, '198361100');
    expect(summary.spending.single.category, 'Food');
    expect(summary.recent.single.title, 'Shoprite');
    expect(summary.recent.single.category, 'Food');
  });

  test('rejects a money field that arrived as a JSON number', () {
    expect(
      () => LedgerTransaction.fromJson({..._tx, 'amountMinor': 198361100}),
      throwsFormatException,
    );
  });

  test('describes an import without echoing a password', () {
    final result = StatementFileResult.fromJson({
      'file': 'sample.csv',
      'ok': {
        'institution': 'GTBank',
        'currency': 'NGN',
        'rowsRead': 7,
        'created': 7,
        'duplicates': 0,
        'accountLast4': '4521',
        'balanceBreaks': 0,
        'gap': null,
        'complete': true,
      },
    });
    expect(result.describe(), 'GTBank ••4521: 7 new, 0 already imported.');
  });

  test('reads an affordability answer with every amount as minor units', () {
    final check = AffordabilityCheck.fromJson(affordabilityResponse);
    expect(check.verdict, 'stretch');
    expect(check.monthlyIncomeMinor, '100000000');
    expect(check.headroomMinor, '-19833334');
    expect(check.obligations.map((o) => o.category), ['Housing', 'Debt']);
    expect(check.obligations.last.nextDue, isNull);
    expect(check.monthsToSave, 1);
    expect(check.lowestOn, DateTime.utc(2026, 10, 25, 11));
  });

  test('rejects an affordability answer with a numeric amount or an unknown verdict', () {
    final inputs = Map<String, Object?>.from(affordabilityResponse['inputs']! as Map);
    expect(() => AffordabilityCheck.fromJson({...affordabilityResponse, 'inputs': {...inputs, 'cashMinor': 181500000}}), throwsFormatException);
    expect(() => AffordabilityCheck.fromJson({...affordabilityResponse, 'verdict': 'maybe'}), throwsFormatException);
  });
}

const _tx = {
  'id': 't1',
  'accountId': 'a1',
  'accountName': 'GTBank NGN ••4521',
  'institution': 'GTBank',
  'maskedAccountNumber': '****4521',
  'transactionDate': '2026-09-19T00:00:00.000Z',
  'type': 'DEBIT',
  'amountMinor': '4525050',
  'currency': 'NGN',
  'description': 'POS SHOPRITE LEKKI',
  'merchantName': 'Shoprite',
  'counterparty': null,
  'category': 'Food',
  'subcategory': null,
};
