import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/screens/home_screen.dart';
import 'package:ledger_mobile/screens/home_shell.dart';
import 'package:ledger_mobile/screens/review_screen.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:ledger_mobile/theme.dart';

const _overview = {
  'period': {'label': 'October 2026', 'from': '2026-09-30T23:00:00.000Z', 'to': '2026-10-31T23:00:00.000Z', 'month': '2026-10'},
  'inMinor': '125000000',
  'outMinor': '98000000',
  'leftMinor': '27000000',
  'keptBp': 2160,
  'prevOutMinor': '91000000',
  'reviewCount': 4,
  'categories': [
    {'category': 'Housing', 'totalMinor': '42000000', 'count': 3, 'shareBp': 4286},
    {'category': 'Food', 'totalMinor': '18000000', 'count': 2, 'shareBp': 1837},
    {'category': 'Transport', 'totalMinor': '12000000', 'count': 1, 'shareBp': 1224},
    {'category': 'Family', 'totalMinor': '9500000', 'count': 1, 'shareBp': 969},
    {'category': 'Utilities', 'totalMinor': '6000000', 'count': 1, 'shareBp': 612},
    {'category': 'Shopping', 'totalMinor': '10500000', 'count': 1, 'shareBp': 1071},
  ],
  'incomeSources': [
    {'name': 'Example Payroll Ltd', 'kind': 'Salary', 'totalMinor': '125000000', 'count': 1},
  ],
};

const _housing = {
  'category': 'Housing',
  'period': {'label': 'October 2026', 'from': '2026-09-30T23:00:00.000Z', 'to': '2026-10-31T23:00:00.000Z'},
  'totalMinor': '42000000',
  'count': 3,
  'shareBp': 4286,
  'avg6mMinor': '18666666',
  'subcategories': [
    {'name': 'Rent', 'totalMinor': '35000000', 'count': 1},
    {'name': 'Home services', 'totalMinor': '4500000', 'count': 1},
    {'name': 'Generator & diesel', 'totalMinor': '2500000', 'count': 2},
  ],
};

http.Response _json(Object body) => http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

Future<LedgerController> _signedIn(Future<http.Response> Function(http.Request request) handler) async {
  final controller = LedgerController(MemorySettingsStore(), httpClient: MockClient(handler));
  await controller.load();
  controller.serverUrl = 'http://100.64.0.8:3000';
  controller.token = 'token-token-token-token';
  return controller;
}

void main() {
  testWidgets('Home shows In Out Left, ranked bars, and a one-line Review chip', (tester) async {
    final overview = MonthOverview.fromJson(_overview);
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(body: ListView(children: [HomeBody(overview: overview, month: '2026-10')])),
      ),
    );
    expect(find.text('IN'), findsOneWidget);
    expect(find.text('OUT'), findsOneWidget);
    expect(find.text('LEFT'), findsOneWidget);
    expect(find.text('₦1.25M'), findsOneWidget);
    expect(find.text('₦980k'), findsOneWidget);
    expect(find.text('₦270k'), findsOneWidget);
    expect(find.text('22% kept'), findsOneWidget);
    expect(find.text('1. Housing'), findsOneWidget);
    expect(find.text('43% of Out'), findsOneWidget);
    expect(find.text('All 6 categories'), findsOneWidget);
    expect(find.text('+₦105k'), findsOneWidget);
    expect(find.text('4 questions to review'), findsOneWidget);
    expect(find.text('Review'), findsOneWidget);
    expect(find.textContaining('rent spread'), findsNothing);
  });

  testWidgets('tapping a category opens ranked subcategories then transactions', (tester) async {
    final seen = <String>[];
    final controller = await _signedIn((request) async {
      seen.add(request.url.path);
      if (request.url.path.contains('/categories/')) return _json(_housing);
      if (request.url.path.endsWith('/transactions')) {
        return _json({
          'transactions': [
            {
              'id': 't1',
              'accountId': 'a1',
              'transactionDate': '2026-10-23T12:00:00.000Z',
              'type': 'DEBIT',
              'amountMinor': '2000000',
              'currency': 'NGN',
              'description': 'Example Cleaning Co',
              'merchantName': 'Example Cleaning Co',
              'category': 'Housing',
              'subcategory': 'Home services',
            },
          ],
          'nextCursor': null,
          'dayTotals': [
            {'date': '2026-10-23', 'netMinor': '-2000000', 'inMinor': '0', 'outMinor': '2000000'},
          ],
          'categories': ['Housing'],
        });
      }
      if (request.url.path.endsWith('/review')) return _json({'questions': [], 'suggestions': [], 'totalMinor': '0', 'categories': []});
      return _json({'error': 'not found'});
    });
    await tester.pumpWidget(
      ChangeNotifierProvider<LedgerController>.value(
        value: controller,
        child: MaterialApp(
          theme: ledgerTheme(Brightness.light),
          home: Scaffold(body: ListView(children: [HomeBody(overview: MonthOverview.fromJson(_overview), month: '2026-10')])),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('category-Housing')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Housing'), findsWidgets);
    expect(find.text('Rent'), findsOneWidget);
    expect(find.text('Home services'), findsOneWidget);
    await tester.tap(find.byKey(const Key('subcategory-Home services')));
    await tester.pumpAndSettle();
    expect(find.text('Example Cleaning Co'), findsOneWidget);
    expect(find.textContaining('Fri 23 Oct'), findsOneWidget);
    controller.dispose();
  });

  testWidgets('bottom nav has Home, Activity, Ask and More', (tester) async {
    final controller = await _signedIn((request) async {
      if (request.url.path.endsWith('/overview')) return _json(_overview);
      if (request.url.path.endsWith('/onboarding')) {
        return http.Response(jsonEncode({'error': 'missing'}), 404, headers: {'content-type': 'application/json'});
      }
      if (request.url.path.endsWith('/transactions')) {
        return _json({'transactions': [], 'nextCursor': null, 'dayTotals': [], 'categories': []});
      }
      if (request.url.path.endsWith('/ask')) return _json({'messages': []});
      return _json({'error': 'not found'});
    });
    await tester.pumpWidget(
      ChangeNotifierProvider<LedgerController>.value(
        value: controller,
        child: MaterialApp(theme: ledgerTheme(Brightness.light), home: const HomeShell()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Home'), findsWidgets);
    expect(find.text('Activity'), findsOneWidget);
    expect(find.text('Ask'), findsOneWidget);
    expect(find.text('More'), findsOneWidget);
    expect(find.text('Accounts'), findsNothing);
    expect(find.text('Upload'), findsNothing);
    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    expect(find.text('Review'), findsOneWidget);
    expect(find.text('Insights'), findsOneWidget);
    expect(find.text('Accounts and balances'), findsOneWidget);
    expect(find.text('Bank alerts'), findsOneWidget);
    expect(find.text('4'), findsWidgets);
    controller.dispose();
  });

  testWidgets('Deel advance review card uses the row currency, not naira', (tester) async {
    final question = ReviewQuestion.fromJson({
      'kind': 'advance',
      'key': 'fx-advance:t1',
      'title': 'Unmatched Deel salary advance',
      'prompt': r'$1,500.00 on 2026-05-15 looks like a Deel salary advance without a matching repayment (or the other way around). It is not counted as income or spending until it pairs, or you say it is a real loan.',
      'totalMinor': '150000',
      'totalCurrency': 'USD',
      'count': 1,
      'examples': ['Deel salary advance'],
      'options': [
        {'value': 'hold', 'label': 'Leave uncounted until a matching repayment lands', 'category': 'Own transfer'},
        {'value': 'debt', 'label': 'This is a real loan - count it as debt', 'category': 'Debt'},
      ],
      'allowsOther': false,
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(
          body: ListView(
            children: [
              ReviewQuestionCard(question: question, index: 0, total: 1, busy: false, onAnswer: (_, {otherText, otherCategory, vendorCategory, vendorSubcategory}) {}, onOther: () {}),
            ],
          ),
        ),
      ),
    );
    expect(find.textContaining(r'$1,500.00'), findsWidgets);
    expect(find.textContaining('₦'), findsNothing);
    expect(find.textContaining('—'), findsNothing);
    expect(find.text('This is a real loan - count it as debt'), findsOneWidget);
  });

  testWidgets('LEFT uses the freed projection and the cleared-loan card dismisses', (tester) async {
    var dismissed = '';
    final overview = MonthOverview.fromJson({
      ..._overview,
      'projectedLeftMinor': '39000000',
      'loanCleared': [
        {
          'id': 'evt-1',
          'loanId': 'loan-1',
          'lender': 'Renmoney',
          'totalRepaidMinor': '36000000',
          'freedPerMonthMinor': '12000000',
          'closedAt': '2026-10-20T09:00:00.000Z',
        },
      ],
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(
          body: ListView(
            children: [
              HomeBody(
                overview: overview,
                month: '2026-10',
                onDismissCleared: (id) async {
                  dismissed = id;
                },
              ),
            ],
          ),
        ),
      ),
    );
    expect(find.text('₦390k'), findsOneWidget);
    expect(find.text('₦270k'), findsNothing);
    expect(find.text('Renmoney is fully paid. That frees up about ₦120,000 a month.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('loan-cleared-dismiss-evt-1')));
    expect(dismissed, 'evt-1');
  });
}
