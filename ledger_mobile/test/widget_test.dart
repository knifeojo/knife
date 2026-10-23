import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/app.dart';
import 'package:ledger_mobile/screens/accounts_screen.dart';
import 'package:ledger_mobile/screens/affordability_screen.dart';
import 'package:ledger_mobile/screens/summary_screen.dart';
import 'package:ledger_mobile/screens/transactions_screen.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:ledger_mobile/theme.dart';

import 'affordability_fixture.dart';

void main() {
  testWidgets('asks for a server and rejects a URL that is not an origin', (tester) async {
    var calls = 0;
    final controller = LedgerController(
      MemorySettingsStore(),
      httpClient: MockClient((request) async {
        calls += 1;
        return http.Response('{}', 500);
      }),
    );
    await controller.load();
    await tester.pumpWidget(LedgerApp(controller: controller));

    expect(find.text('Where is Ledger running?'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('server-url')), 'not a url');
    await tester.tap(find.byKey(const Key('connect')));
    await tester.pump();
    expect(find.textContaining('full URL'), findsOneWidget);
    expect(calls, 0);
    controller.dispose();
  });

  testWidgets('signs in and shows the home summary', (tester) async {
    final controller = LedgerController(MemorySettingsStore(), httpClient: MockClient(_api));
    await controller.load();
    await tester.pumpWidget(LedgerApp(controller: controller));

    await tester.enterText(find.byKey(const Key('server-url')), 'http://100.64.0.8:3000');
    await tester.tap(find.byKey(const Key('connect')));
    await tester.pumpAndSettle();
    expect(find.text('Sign in'), findsWidgets);

    await tester.enterText(find.byKey(const Key('email')), 'ada@ledger.test');
    await tester.enterText(find.byKey(const Key('password')), 'correct-horse');
    await tester.tap(find.byKey(const Key('submit-auth')));
    await tester.pumpAndSettle();

    expect(find.text('September 2026'), findsOneWidget);
    expect(find.text('₦1,983,611.00'), findsOneWidget);
    expect(find.text('Food'), findsWidgets);
    expect(find.text('Shoprite'), findsOneWidget);

    await tester.tap(find.text('Afford'));
    await tester.pumpAndSettle();
    expect(find.text('Can I really afford this?'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('afford-amount')), '1.6m');
    await tester.enterText(find.byKey(const Key('afford-description')), 'a car deposit');
    await tester.ensureVisible(find.byKey(const Key('afford-check')));
    await tester.tap(find.byKey(const Key('afford-check')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Stretch'), 200, scrollable: find.descendant(of: find.byKey(const Key('afford-list')), matching: find.byType(Scrollable)).first);
    expect(find.text('Stretch'), findsOneWidget);
    expect(find.textContaining("It's a stretch."), findsOneWidget);
    controller.dispose();
  });

  testWidgets('account and transaction views show balances and categories', (tester) async {
    final account = LedgerAccount(
      id: 'a1',
      institution: 'GTBank',
      accountName: 'GTBank NGN ••4521',
      maskedAccountNumber: '****4521',
      currency: 'NGN',
      balanceMinor: '450000000',
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(
          body: AccountListView(
            accounts: AccountList(accounts: [account], totalBaseMinor: '450000000', totalBaseCurrency: 'NGN'),
          ),
        ),
      ),
    );
    expect(find.textContaining('****4521'), findsOneWidget);
    expect(find.text('₦4,500,000.00'), findsWidgets);

    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(
          body: TransactionList(
            page: TransactionPage(
              transactions: [
                LedgerTransaction(
                  id: 't1',
                  accountId: 'a1',
                  transactionDate: DateTime.utc(2026, 9, 19),
                  type: 'DEBIT',
                  amountMinor: '4525050',
                  currency: 'NGN',
                  description: 'POS SHOPRITE LEKKI',
                  merchantName: 'Shoprite',
                  category: 'Food',
                ),
              ],
              total: 1,
              page: 1,
              pageSize: 50,
              categories: const ['Food', 'Income'],
            ),
          ),
        ),
      ),
    );
    expect(find.text('Food'), findsOneWidget);
    expect(find.text('Shoprite'), findsOneWidget);
    expect(find.textContaining('₦45,250.50'), findsOneWidget);
    expect(find.byType(CadenceChip), findsNothing);
  });

  testWidgets('transactions show recurring and one-off chips', (tester) async {
    LedgerTransaction tx(String id, String name, String category, {String? cadence, bool bill = false}) => LedgerTransaction(
          id: id,
          accountId: 'a1',
          transactionDate: DateTime.utc(2026, 8, 1),
          type: 'DEBIT',
          amountMinor: '40000000',
          currency: 'NGN',
          description: name,
          merchantName: name,
          category: category,
          cadence: cadence,
          recurringBill: bill,
        );
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(
          body: SingleChildScrollView(
            child: TransactionList(
              page: TransactionPage(
                transactions: [
                  tx('t1', 'Landlord', 'Housing', cadence: 'recurring', bill: true),
                  tx('t2', 'Netflix', 'Entertainment', cadence: 'recurring'),
                  tx('t3', 'Fouani Showroom', 'Shopping', cadence: 'one_off'),
                  tx('t4', 'PiggyVest', 'Own transfer'),
                ],
                total: 4,
                page: 1,
                pageSize: 50,
                categories: const ['Housing'],
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('Recurring bill'), findsOneWidget);
    expect(find.text('Recurring'), findsOneWidget);
    expect(find.text('One-off'), findsOneWidget);
    expect(find.byType(CadenceChip), findsNWidgets(3));
  });

  testWidgets('summary splits spending into recurring and one-off', (tester) async {
    final summary = HomeSummary.fromJson({
      ..._summaryJson,
      'spendingByCategory': [
        {'category': 'Housing', 'totalMinor': '40000000', 'count': 1, 'recurringMinor': '40000000', 'oneOffMinor': '0'},
      ],
      'spendingSplit': {
        'recurringBillsMinor': '40000000',
        'recurringOtherMinor': '0',
        'oneOffMinor': '65000000',
        'everydayMinor': '1845000',
        'oneOffMinMinor': '5000000',
        'labelled': true,
        'oneOffs': [
          {'id': 't9', 'name': 'Fouani Showroom', 'category': 'Shopping', 'subcategory': 'Electronics', 'amountMinor': '65000000', 'date': '2026-09-12T00:00:00.000Z'},
        ],
      },
    });
    await tester.pumpWidget(
      MaterialApp(theme: ledgerTheme(Brightness.light), home: Scaffold(body: ListView(children: [SummaryBody(summary: summary)]))),
    );
    expect(find.text('Recurring vs one-off'), findsOneWidget);
    expect(find.text('Recurring bills'), findsOneWidget);
    expect(find.text('Each ₦50,000.00+'), findsOneWidget);
    expect(find.text('Fouani Showroom'), findsOneWidget);
    expect(find.text('1 · ₦400,000.00 recurring'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(theme: ledgerTheme(Brightness.light), home: Scaffold(body: ListView(children: [SummaryBody(summary: HomeSummary.fromJson(_summaryJson))]))),
    );
    expect(find.text('Recurring vs one-off'), findsNothing);
    expect(find.text('1'), findsOneWidget);
  });

  testWidgets('affordability answer shows the verdict and the inputs behind it', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(body: ListView(children: [AffordabilityAnswer(result: AffordabilityCheck.fromJson(affordabilityResponse))])),
      ),
    );
    expect(find.text('Stretch'), findsOneWidget);
    expect(find.textContaining('below your ₦400,000.00 safety buffer'), findsOneWidget);
    expect(find.text('₦1,000,000.00'), findsOneWidget);
    expect(find.text('FairMoney · Loan repayment'), findsOneWidget);
    expect(find.text('-₦1,600,000.00'), findsOneWidget);
    expect(find.text('-₦198,333.34'), findsOneWidget);
    expect(find.text('What would help'), findsOneWidget);
    expect(find.text('Loan'), findsOneWidget);
    expect(find.text('One-off'), findsOneWidget);
    expect(find.textContaining('Clear FairMoney first.'), findsOneWidget);
    expect(find.text('Recurring bills'), findsOneWidget);
    expect(find.textContaining('One-off spends since '), findsOneWidget);
    expect(find.text('Fouani Showroom · Electronics, 12 Aug 2026'), findsOneWidget);
    expect(find.text('All one-offs'), findsOneWidget);
    expect(find.textContaining('—'), findsNothing);
  });

  testWidgets('a yes shows one tip, not next steps', (tester) async {
    const tip = 'You still repay FairMoney about ₦50,000 a month. Clearing it first leaves more room for what comes next.';
    final yes = AffordabilityCheck.fromJson({
      ...affordabilityResponse,
      'verdict': 'yes',
      'advice': [
        {'kind': 'debt', 'text': tip, 'subject': 'FairMoney', 'monthlyMinor': '5000000', 'openMinor': null},
      ],
    });
    await tester.pumpWidget(MaterialApp(theme: ledgerTheme(Brightness.light), home: Scaffold(body: ListView(children: [AffordabilityAnswer(result: yes)]))));
    expect(find.text('One tip'), findsOneWidget);
    expect(find.text(tip), findsOneWidget);
    expect(find.text('What would help'), findsNothing);
  });
}

Future<http.Response> _api(http.Request request) async {
  final path = request.url.path;
  if (path.endsWith('/health')) {
    return http.Response(jsonEncode({'ok': true, 'service': 'ledger', 'version': 1}), 200);
  }
  if (path.endsWith('/auth/login')) {
    return http.Response(
      jsonEncode({
        'token': 'token-token-token-token',
        'expiresAt': '2026-11-20T00:00:00.000Z',
        'user': {'id': 'u1', 'email': 'ada@ledger.test', 'name': 'Ada', 'isDemo': false},
      }),
      200,
    );
  }
  if (path.endsWith('/summary')) {
    return http.Response(jsonEncode(_summaryJson), 200);
  }
  if (path.endsWith('/accounts')) {
    return http.Response(jsonEncode({'accounts': [], 'totalBaseMinor': '0', 'totalBaseCurrency': 'NGN'}), 200);
  }
  if (path.endsWith('/affordability')) {
    expect(jsonDecode(request.body), {'amountMinor': '160000000', 'description': 'a car deposit', 'horizon': 'month_end'});
    return http.Response(jsonEncode(affordabilityResponse), 200, headers: {'content-type': 'application/json; charset=utf-8'});
  }
  if (path.endsWith('/transactions')) {
    return http.Response(jsonEncode({'transactions': [], 'total': 0, 'page': 1, 'pageSize': 50, 'categories': ['Food', 'Income']}), 200);
  }
  return http.Response(jsonEncode({'error': 'not found'}), 404);
}

/// What a server from before the recurring vs one-off split sends.
const _summaryJson = {
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
  'recent': [
    {
      'id': 't1',
      'accountId': 'a1',
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
    },
  ],
};
