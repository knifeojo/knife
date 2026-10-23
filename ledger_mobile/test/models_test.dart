import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/api/models.dart';

import 'affordability_fixture.dart';
import 'intelligence_fixture.dart';

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

  test('reads recurring vs one-off labels and the spending split', () {
    final summary = HomeSummary.fromJson({
      'period': {'label': 'August 2026', 'from': '2026-07-31T23:00:00.000Z', 'to': '2026-08-31T23:00:00.000Z'},
      'incomeMinor': '200000000',
      'expensesMinor': '123000000',
      'netMinor': '77000000',
      'balanceMinor': '450000000',
      'balanceCurrency': 'NGN',
      'count': 9,
      'spendingByCategory': [
        {'category': 'Housing', 'totalMinor': '40000000', 'count': 1, 'recurringMinor': '40000000', 'oneOffMinor': '0'},
      ],
      'spendingSplit': {
        'recurringBillsMinor': '40000000',
        'recurringOtherMinor': '8000000',
        'oneOffMinor': '65000000',
        'everydayMinor': '10000000',
        'oneOffMinMinor': '5000000',
        'labelled': true,
        'oneOffs': [
          {'id': 't9', 'name': 'Fouani Showroom', 'category': 'Shopping', 'subcategory': 'Electronics', 'amountMinor': '65000000', 'date': '2026-08-12T00:00:00.000Z'},
        ],
      },
      'recent': [
        {..._tx, 'cadence': 'recurring', 'recurringBill': true},
        {..._tx, 'id': 't2', 'cadence': 'one_off', 'recurringBill': false},
        {..._tx, 'id': 't3', 'cadence': null, 'recurringBill': false},
      ],
    });
    expect(summary.spending.single.recurringMinor, '40000000');
    expect(summary.split!.oneOffMinor, '65000000');
    expect(summary.split!.oneOffs.single.name, 'Fouani Showroom');
    expect(summary.recent.map((tx) => tx.cadenceLabel), ['Recurring bill', 'One-off', null]);
  });

  test('reads a summary from an older server with no cadence fields', () {
    final summary = HomeSummary.fromJson({
      'period': {'label': 'September 2026'},
      'incomeMinor': '0',
      'expensesMinor': '1845000',
      'netMinor': '-1845000',
      'balanceMinor': '0',
      'balanceCurrency': 'NGN',
      'count': 1,
      'spendingByCategory': [
        {'category': 'Food', 'totalMinor': '1845000', 'count': 1},
      ],
      'recent': [_tx],
    });
    expect(summary.split, isNull);
    expect(summary.spending.single.recurringMinor, '0');
    expect(summary.spending.single.oneOffMinor, '0');
    expect(summary.recent.single.cadence, isNull);
    expect(summary.recent.single.recurringBill, isFalse);
  });

  test('drops a cadence it does not know instead of failing the list', () {
    final tx = LedgerTransaction.fromJson({..._tx, 'cadence': 'weekly'});
    expect(tx.cadence, isNull);
    expect(tx.cadenceLabel, isNull);
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
    expect(check.obligations.map((o) => o.kind), ['recurring', 'recurring']);
    expect(check.advice.map((a) => a.kind), ['debt', 'one_off']);
    expect(check.advice.first.subject, 'FairMoney');
    expect(check.advice.first.monthlyMinor, '5000000');
    expect(check.advice.first.openMinor, isNull);
    expect(check.oneOffs.single.name, 'Fouani Showroom');
    expect(check.oneOffs.single.amountMinor, '45000000');
    expect(check.oneOffsTotalMinor, '45000000');
    expect(check.oneOffsSince, DateTime.utc(2026, 6, 30, 23));
  });

  test('reads an answer from an older server that sends no advice or one-offs', () {
    final inputs = Map<String, Object?>.from(affordabilityResponse['inputs']! as Map)
      ..remove('oneOffs')
      ..remove('oneOffsTotalMinor')
      ..remove('oneOffMinMinor')
      ..remove('oneOffsSince');
    final check = AffordabilityCheck.fromJson({...affordabilityResponse, 'inputs': inputs}..remove('advice'));
    expect(check.advice, isEmpty);
    expect(check.oneOffs, isEmpty);
    expect(check.oneOffsSince, isNull);
  });

  test('rejects an affordability answer with a numeric amount or an unknown verdict', () {
    final inputs = Map<String, Object?>.from(affordabilityResponse['inputs']! as Map);
    expect(() => AffordabilityCheck.fromJson({...affordabilityResponse, 'inputs': {...inputs, 'cashMinor': 181500000}}), throwsFormatException);
    expect(() => AffordabilityCheck.fromJson({...affordabilityResponse, 'verdict': 'maybe'}), throwsFormatException);
    final numericCut = {'kind': 'cut', 'text': 'x', 'subject': 'Food', 'monthlyMinor': 3000000, 'openMinor': null};
    expect(() => AffordabilityCheck.fromJson({...affordabilityResponse, 'advice': [numericCut]}), throwsFormatException);
    final unknownKind = {'kind': 'guess', 'text': 'x', 'subject': null, 'monthlyMinor': null, 'openMinor': null};
    expect(() => AffordabilityCheck.fromJson({...affordabilityResponse, 'advice': [unknownKind]}), throwsFormatException);
  });

  test('reads matched payees, named recurring groups, the everyday breakdown and the Review prompt', () {
    final summary = HomeSummary.fromJson(intelligenceSummary);
    final split = summary.split!;
    expect(summary.periodFrom, DateTime.utc(2026, 7, 31, 23));
    expect(split.everyday!.byCategory.single.name, 'Transfers');
    expect(split.everyday!.byPayee.first.totalMinor, '8500000');
    expect(split.unlabelled!.count, 6);
    expect(split.unlabelled!.totalMinor, '27000000');
    expect(split.unlabelled!.needsReview, isTrue);
    expect(split.unlabelled!.reviewQuestions, 4);
    final chidi = split.payees.firstWhere((p) => p.name == 'Chidi Emeka Okeke');
    expect(chidi.variants, ['Okeke Chidie']);
    expect(chidi.unlabelledMinor, '8500000');
    expect(chidi.regular, isNull);
    expect(split.payees.map((p) => p.regular), ['fixed', null, 'frequent']);
    final grace = summary.recurring.firstWhere((g) => g.name == 'Grace Nneka Eze');
    expect(grace.kind, 'variable');
    expect(grace.kindLabel, 'Monthly, amount varies');
    expect(grace.aliases, ['Eze Grace', 'Gracen Eze']);
    expect(summary.recurring.first.bill, isTrue);
    expect(summary.recurring.first.averageMinor, '25000000');
  });

  test('a split from a server before payee matching still reads', () {
    final split = SpendingSplit.fromJson({
      'recurringBillsMinor': '0',
      'recurringOtherMinor': '0',
      'oneOffMinor': '0',
      'everydayMinor': '0',
      'oneOffMinMinor': '5000000',
      'labelled': true,
    });
    expect(split.everyday, isNull);
    expect(split.payees, isEmpty);
    expect(split.unlabelled, isNull);
    expect(HomeSummary.fromJson({...intelligenceSummary, 'recurring': null}).recurring, isEmpty);
  });

  test('keeps an unknown recurring kind from failing the summary', () {
    final payee = PayeeSpend.fromJson({...(intelligenceSummary['spendingSplit'] as Map)['payees'][0] as Map<String, dynamic>, 'regular': 'weekly'});
    expect(payee.regular, isNull);
    expect(() => PayeeSpend.fromJson({...(intelligenceSummary['spendingSplit'] as Map)['payees'][0] as Map<String, dynamic>, 'totalMinor': 250000}), throwsFormatException);
  });

  test('reads Review questions with the full narration and hints from it', () {
    final queue = ReviewQueue.fromJson(reviewResponse);
    final q = queue.questions.single;
    expect(q.examples.single, wardrobeNarration);
    expect(q.narrationHints.single.words, 'wardrobe');
    expect(q.narrationHints.single.category, 'Housing');
    expect(q.options.map((o) => o.value), ['family', 'friend']);
    expect(q.allowsOther, isTrue);
    expect(queue.categories, contains('Housing'));
    expect(CategorizeResult.fromJson({'checked': 40, 'changed': 3, 'message': 'Re-checked 40'}).changed, 3);
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
