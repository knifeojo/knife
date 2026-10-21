import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/api/models.dart';

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
