import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/app.dart';
import 'package:ledger_mobile/screens/accounts_screen.dart';
import 'package:ledger_mobile/screens/affordability_screen.dart';
import 'package:ledger_mobile/screens/everyday_screen.dart';
import 'package:ledger_mobile/screens/review_screen.dart';
import 'package:ledger_mobile/screens/settings_screen.dart';
import 'package:ledger_mobile/screens/summary_screen.dart';
import 'package:ledger_mobile/screens/transactions_screen.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:ledger_mobile/theme.dart';

import 'affordability_fixture.dart';
import 'intelligence_fixture.dart';

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

    expect(find.text('IN'), findsOneWidget);
    expect(find.text('OUT'), findsOneWidget);
    expect(find.text('LEFT'), findsOneWidget);
    expect(find.text('1. Food'), findsOneWidget);

    await tester.tap(find.text('Ask'));
    await tester.pumpAndSettle();
    expect(find.text('Can I afford...?'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('ask-input')), 'Can I afford 1.6m a car deposit');
    await tester.tap(find.byKey(const Key('ask-send')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Stretch'), 200, scrollable: find.descendant(of: find.byKey(const Key('ask-list')), matching: find.byType(Scrollable)).first);
    expect(find.text('Stretch'), findsOneWidget);
    expect(find.textContaining("It's a stretch."), findsWidgets);
    expect(find.textContaining('Keep at least'), findsOneWidget);
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
    expect(find.text('Shoprite'), findsOneWidget);
    expect(find.textContaining('₦45,250.50'), findsOneWidget);
    await tester.tap(find.text('Shoprite'));
    await tester.pumpAndSettle();
    expect(find.text('Food'), findsOneWidget);
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
    await tester.tap(find.text('Landlord'));
    await tester.pumpAndSettle();
    expect(find.text('Recurring bill'), findsOneWidget);
    expect(find.byType(CadenceChip), findsOneWidget);
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

  testWidgets('home shows what was spent on, recurring by name, the everyday breakdown and the Review prompt', (tester) async {
    final requests = <http.Request>[];
    final controller = await _signedIn((request) async {
      requests.add(request);
      final path = request.url.path;
      if (path.endsWith('/transactions')) {
        return http.Response(jsonEncode({'transactions': [], 'total': 0, 'page': 1, 'pageSize': 50, 'categories': ['Food']}), 200);
      }
      if (path.endsWith('/review') && request.method == 'GET') return _json(reviewResponse);
      if (path.endsWith('/review')) return _json({'updated': 1});
      if (path.endsWith('/summary')) return _json(intelligenceSummary);
      return http.Response(jsonEncode({'error': 'not found'}), 404);
    });
    final summary = HomeSummary.fromJson(intelligenceSummary);
    var reloaded = 0;
    await tester.pumpWidget(_app(controller, ListView(children: [SummaryBody(summary: summary, onChanged: () => reloaded++)])));

    expect(find.text('6 payments need a purpose. Help Ledger label them'), findsOneWidget);
    expect(find.text('What you spent on'), findsOneWidget);
    expect(find.text('Also written as Okeke Chidie'), findsOneWidget);
    expect(find.text('several times a month'), findsOneWidget);
    expect(find.text('no purpose yet'), findsOneWidget);
    expect(find.text('Recurring, by name'), findsOneWidget);
    expect(find.text('Also written as Eze Grace, Gracen Eze'), findsOneWidget);
    expect(find.text('Transfers · Monthly, amount varies · 3 months'), findsOneWidget);
    expect(find.text('By person or business'), findsOneWidget);

    // A matched payee opens its transactions for the month, every spelling included.
    await tester.ensureVisible(find.byKey(const Key('payee-Chidi Emeka Okeke')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('payee-Chidi Emeka Okeke')));
    await tester.pumpAndSettle();
    expect(find.text('Every spelling of this name is included.'), findsOneWidget);
    expect(requests.last.url.queryParameters, containsPair('payee', 'Chidi Emeka Okeke'));
    expect(requests.last.url.queryParameters, containsPair('from', '2026-08-01'));
    expect(requests.last.url.queryParameters, containsPair('to', '2026-08-31'));
    await tester.pageBack();
    await tester.pumpAndSettle();

    // The Everyday tile is a drill-down.
    await tester.ensureVisible(find.byKey(const Key('everyday-tile')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('everyday-tile')));
    await tester.pumpAndSettle();
    expect(find.byType(EverydayScreen), findsOneWidget);
    expect(find.text('Everyday · August 2026'), findsOneWidget);
    expect(requests.last.url.queryParameters, containsPair('cadence', 'everyday'));
    expect(requests.last.url.queryParameters, containsPair('from', '2026-08-01'));
    await tester.pageBack();
    await tester.pumpAndSettle();

    // The prompt opens Review; answering there reloads Home.
    await tester.ensureVisible(find.byKey(const Key('open-review')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-review')));
    await tester.pumpAndSettle();
    expect(find.byType(ReviewScreen), findsOneWidget);
    expect(find.text(wardrobeNarration), findsOneWidget);
    await tester.tap(find.byKey(const Key('hint-wardrobe')));
    await tester.pumpAndSettle();
    final answer = requests.lastWhere((r) => r.method == 'POST');
    expect(jsonDecode(answer.body), {'kind': 'person', 'key': 'emeka john obi', 'value': 'other', 'otherText': 'wardrobe', 'otherCategory': 'Housing'});
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(reloaded, 1);
    controller.dispose();
  });

  testWidgets('Review shows each full narration and the purpose words found in it', (tester) async {
    final posts = <Object?>[];
    final controller = await _signedIn((request) async {
      if (request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        return _json({'updated': 2});
      }
      return _json(reviewResponse);
    });
    await tester.pumpWidget(_app(controller, const ReviewScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Who is Emeka John Obi?'), findsOneWidget);
    expect(find.text('What your bank wrote'), findsOneWidget);
    final narration = tester.widget<SelectableText>(find.byType(SelectableText));
    expect(narration.data, wardrobeNarration);
    expect(narration.maxLines, isNull);
    expect(find.text('"WARDROBE" → Housing'), findsOneWidget);
    expect(find.text('Family'), findsOneWidget);
    expect(find.text('Can’t remember'), findsOneWidget);

    // "CSR (black tax)": support for extended family, filed under Family / Black tax on the server.
    await tester.ensureVisible(find.text('CSR (black tax)'));
    await tester.tap(find.text('CSR (black tax)'));
    await tester.pumpAndSettle();
    expect(posts, [
      {'kind': 'person', 'key': 'emeka john obi', 'value': 'csr'},
    ]);
    expect(find.text('Saved. 2 payments relabelled.'), findsOneWidget);
    controller.dispose();
  });

  testWidgets('settings re-runs categorization on the server', (tester) async {
    final seen = <String>[];
    final controller = await _signedIn((request) async {
      seen.add('${request.method} ${request.url.path}');
      return _json({'checked': 40, 'changed': 3, 'message': 'Re-checked 40 transactions; 3 changed. Your manual corrections were kept.'});
    });
    await tester.pumpWidget(ChangeNotifierProvider<LedgerController>.value(
      value: controller,
      child: MaterialApp(theme: ledgerTheme(Brightness.light), home: const SettingsScreen()),
    ));
    await tester.tap(find.byKey(const Key('rerun-categorization')));
    await tester.pumpAndSettle();
    expect(seen.where((s) => s.startsWith('POST')), ['POST /api/v1/categorize']);
    expect(find.textContaining('3 changed'), findsOneWidget);
    controller.dispose();
  });
  testWidgets('Review pre-selects the AI pick and confirms it with one tap', (tester) async {
    final posts = <String>[];
    final controller = await _signedIn((request) async {
      if (request.method == 'POST') {
        posts.add('${request.url.path} ${request.body}');
        return _json({'updated': 2});
      }
      return _json(reviewWithAiResponse);
    });
    await tester.pumpWidget(_app(controller, const ReviewScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Confirm Family / Black tax'), findsOneWidget);
    expect(find.textContaining('qwen2.5:3b'), findsWidgets);

    await tester.tap(find.byKey(const Key('confirm-sug1')));
    await tester.pumpAndSettle();
    expect(posts, ['/api/v1/review/suggestions {"id":"sug1","action":"confirm"}']);
    expect(find.text('Saved as Family / Black tax. 2 payments relabelled.'), findsOneWidget);

    final list = find.descendant(of: find.byKey(const Key('review-list')), matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.byKey(const Key('dismiss-sug2')), 200, scrollable: list);
    await tester.ensureVisible(find.byKey(const Key('dismiss-sug2')));
    await tester.pumpAndSettle();
    expect(find.text('Suggested by AI'), findsOneWidget);
    expect(find.text('Confirm Giving / Church'), findsOneWidget);
    await tester.tap(find.byKey(const Key('dismiss-sug2')));
    await tester.pumpAndSettle();
    expect(posts.last, '/api/v1/review/suggestions {"id":"sug2","action":"dismiss"}');
    controller.dispose();
  });

  testWidgets('settings shows AI provider, model and reachability, and toggles it', (tester) async {
    final posts = <Object?>[];
    final controller = await _signedIn((request) async {
      if (request.url.path == '/api/v1/ai' && request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        return _json({...aiStatusResponse, 'enabled': true, 'pendingSuggestions': 3});
      }
      return _json(aiStatusResponse);
    });
    await tester.pumpWidget(ChangeNotifierProvider<LedgerController>.value(
      value: controller,
      child: MaterialApp(theme: ledgerTheme(Brightness.light), home: const SettingsScreen()),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('qwen2.5:3b'), findsWidgets);
    expect(find.text('Reachable'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('ai-toggle')));
    await tester.tap(find.byKey(const Key('ai-toggle')));
    await tester.pumpAndSettle();
    expect(posts, [
      {'enabled': true},
    ]);
    expect(find.textContaining('3 suggestions waiting in Review'), findsOneWidget);
    controller.dispose();
  });

  testWidgets('settings shows both providers, the key state and per-feature routes, and changes one', (tester) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final posts = <Object?>[];
    final controller = await _signedIn((request) async {
      if (request.url.path == '/api/v1/ai' && request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        final routes = Map<String, dynamic>.from(hybridAiStatusResponse['routes'] as Map);
        routes['categorize'] = {...routes['categorize'] as Map, 'route': 'off', 'requested': 'off', 'source': 'user'};
        return _json({...hybridAiStatusResponse, 'routes': routes});
      }
      return _json(hybridAiStatusResponse);
    });
    await tester.pumpWidget(ChangeNotifierProvider<LedgerController>.value(
      value: controller,
      child: MaterialApp(theme: ledgerTheme(Brightness.light), home: const SettingsScreen()),
    ));
    await tester.pumpAndSettle();
    expect(find.textContaining('Local · Ollama · qwen2.5:3b'), findsOneWidget);
    expect(find.textContaining('Cloud · Anthropic'), findsOneWidget);
    expect(find.text('ANTHROPIC_API_KEY: not set'), findsOneWidget);
    expect(find.text('Not configured'), findsOneWidget);
    expect(find.textContaining('local-only'), findsOneWidget);
    expect(find.textContaining('Runs: Local'), findsOneWidget);
    for (final f in ['categorize', 'escalation', 'insights', 'chat']) {
      expect(find.byKey(Key('ai-route-$f')), findsOneWidget);
    }

    await tester.ensureVisible(find.byKey(const Key('ai-route-categorize')));
    await tester.tap(find.byKey(const Key('ai-route-categorize')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Off').last);
    await tester.pumpAndSettle();
    expect(posts, [
      {
        'routes': {'categorize': 'off'},
      },
    ]);
    controller.dispose();
  });

  testWidgets('settings says when the AI is not reachable', (tester) async {
    final controller = await _signedIn((request) async => _json({...aiStatusResponse, 'reachable': false, 'modelInstalled': false, 'message': 'Ollama is not reachable. Start it with "ollama serve".'}));
    await tester.pumpWidget(ChangeNotifierProvider<LedgerController>.value(
      value: controller,
      child: MaterialApp(theme: ledgerTheme(Brightness.light), home: const SettingsScreen()),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Not reachable'), findsOneWidget);
    expect(find.textContaining('ollama serve'), findsOneWidget);
    controller.dispose();
  });
}

Future<LedgerController> _signedIn(Future<http.Response> Function(http.Request request) handler) async {
  final controller = LedgerController(MemorySettingsStore(), httpClient: MockClient(handler));
  await controller.load();
  controller.serverUrl = 'http://100.64.0.8:3000';
  controller.token = 'token-token-token-token';
  return controller;
}

Widget _app(LedgerController controller, Widget body) {
  return ChangeNotifierProvider<LedgerController>.value(
    value: controller,
    child: MaterialApp(theme: ledgerTheme(Brightness.light), home: Scaffold(body: body)),
  );
}

http.Response _json(Object body) => http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

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
  if (path.endsWith('/onboarding')) {
    return http.Response(jsonEncode({'needsOnboarding': false, 'trustNote': '', 'topPeople': {'show': false, 'people': []}, 'statuses': [], 'relationships': []}), 200);
  }
  if (path.endsWith('/overview')) {
    return http.Response(jsonEncode(_overviewJson), 200);
  }
  if (path.endsWith('/summary')) {
    return http.Response(jsonEncode(_summaryJson), 200);
  }
  if (path.endsWith('/accounts')) {
    return http.Response(jsonEncode({'accounts': [], 'totalBaseMinor': '0', 'totalBaseCurrency': 'NGN'}), 200);
  }
  if (path.endsWith('/ask') && request.method == 'GET') {
    return http.Response(jsonEncode({'messages': []}), 200, headers: {'content-type': 'application/json; charset=utf-8'});
  }
  if (path.endsWith('/ask')) {
    expect(jsonDecode(request.body), {'question': 'Can I afford 1.6m a car deposit'});
    return http.Response(
      jsonEncode({
        'message': {
          'id': 'a1',
          'role': 'assistant',
          'text': affordabilityResponse['headline'],
          'mode': 'afford',
          'createdAt': '2026-10-28T12:00:00.000Z',
          'card': {
            'kind': 'afford',
            'keepAtLeastMinor': (affordabilityResponse['projection'] as Map)['lowestMinor'],
            'affordability': affordabilityResponse,
            'freedLoans': [
              {'lender': 'FairMoney', 'freedPerMonthMinor': '5000000'},
            ],
          },
        },
      }),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }
  if (path.endsWith('/transactions')) {
    return http.Response(jsonEncode({'transactions': [], 'nextCursor': null, 'dayTotals': [], 'categories': ['Food', 'Income']}), 200);
  }
  return http.Response(jsonEncode({'error': 'not found'}), 404);
}

const _overviewJson = {
  'period': {'label': 'October 2026', 'from': '2026-09-30T23:00:00.000Z', 'to': '2026-10-31T23:00:00.000Z', 'month': '2026-10'},
  'inMinor': '198361100',
  'outMinor': '42370050',
  'leftMinor': '155991050',
  'keptBp': 7864,
  'prevOutMinor': '40000000',
  'reviewCount': 0,
  'categories': [
    {'category': 'Food', 'totalMinor': '1845000', 'count': 1, 'shareBp': 435},
  ],
  'incomeSources': [
    {'name': 'Example Payroll Ltd', 'kind': 'Salary', 'totalMinor': '198361100', 'count': 1},
  ],
};

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
