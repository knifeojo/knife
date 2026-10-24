import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:ledger_mobile/api/client.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/format.dart';
import 'package:ledger_mobile/screens/affordability_screen.dart';
import 'package:ledger_mobile/screens/loans_screen.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:ledger_mobile/theme.dart';

import 'affordability_fixture.dart';

// Synthetic loans only, shaped like GET /api/v1/loans.
const _lenders = ['FairMoney', 'Renmoney', 'PalmCredit', 'Carbon'];
const _openLoan = <String, Object?>{
  'id': 'loan_a',
  'lender': 'Renmoney',
  'outstandingMinor': '125000050',
  'instalmentMinor': '25000000',
  'instalmentsPaid': 3,
  'instalmentsTotal': 8,
  'instalmentsLeft': 5,
  'nextDueDate': '2026-11-30T00:00:00.000Z',
  'endDate': null,
  'payoffDate': '2027-03-30T00:00:00.000Z',
  'notes': 'Generator loan',
  'status': 'open',
  'balanceAsOf': '2026-10-20T10:00:00.000Z',
  'closedAt': null,
  'repaymentsSince': {'count': 1, 'totalMinor': '25000000', 'lastDate': '2026-10-30T00:00:00.000Z'},
};
const _closedLoan = <String, Object?>{
  'id': 'loan_b',
  'lender': 'FairMoney',
  'outstandingMinor': '0',
  'status': 'closed',
  'balanceAsOf': '2026-05-01T10:00:00.000Z',
  'closedAt': '2026-06-02T10:00:00.000Z',
};
const _loansResponse = <String, Object?>{
  'loans': [_openLoan, _closedLoan],
  'lenders': _lenders,
};

const _manualAdvice = <String, Object?>{
  'kind': 'debt',
  'text': 'Clear Renmoney: ₦1.25m left, last payment 30 Mar. 5 of 8 instalments to go. After that, ₦250,000 a month is free.',
  'subject': 'Renmoney',
  'monthlyMinor': '25000000',
  'openMinor': '125000050',
  'loan': {
    'id': 'loan_a',
    'outstandingMinor': '125000050',
    'balanceAsOf': '2026-10-20T10:00:00.000Z',
    'endsOn': '2027-03-30T00:00:00.000Z',
    'instalmentsLeft': 5,
    'repaymentsSince': 0,
    'repaidSinceMinor': '0',
  },
};

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

Future<LedgerController> _signedIn(Future<http.Response> Function(http.Request request) handler) async {
  final controller = LedgerController(MemorySettingsStore(), httpClient: MockClient(handler));
  await controller.load();
  controller.serverUrl = 'http://100.64.0.8:3000';
  controller.token = 'token-token-token-token';
  return controller;
}

/// The loan form is a lazy list: fields below the fold are built once scrolled to.
Future<void> _reveal(WidgetTester tester, String key) async {
  await tester.scrollUntilVisible(find.byKey(Key(key)), 120, scrollable: find.descendant(of: find.byKey(const Key('loan-form')), matching: find.byType(Scrollable)).first);
}

Widget _app(LedgerController controller, Widget home) {
  return ChangeNotifierProvider<LedgerController>.value(
    value: controller,
    child: MaterialApp(theme: ledgerTheme(Brightness.light), home: home),
  );
}

void main() {
  group('models', () {
    test('reads loans with kobo as strings and calendar days', () {
      final list = LoanList.fromJson(_loansResponse);
      expect(list.lenders, _lenders);
      final open = list.loans.first;
      expect(open.isOpen, isTrue);
      expect(open.outstandingMinor, '125000050');
      expect(open.instalmentsLeft, 5);
      expect(open.repaymentsSince, 1);
      expect(open.repaidSinceMinor, '25000000');
      expect(formatCalendarDay(open.payoffDate!), '30 Mar 2027');
      final closed = list.loans.last;
      expect(closed.isOpen, isFalse);
      expect(closed.instalmentMinor, isNull);
      expect(closed.repaymentsSince, 0);
    });

    test('advice from an older server has no loan, and the new loan field parses when present', () {
      final old = AffordabilityCheck.fromJson(affordabilityResponse);
      expect(old.advice.first.loan, isNull);
      final withLoan = AffordabilityCheck.fromJson({
        ...affordabilityResponse,
        'advice': [_manualAdvice],
      });
      final loan = withLoan.advice.single.loan!;
      expect(loan.outstandingMinor, '125000050');
      expect(loan.endsOn, DateTime.utc(2027, 3, 30));
      expect(withLoan.advice.single.openMinor, '125000050');
      // Fields a newer server might add later are ignored.
      final future = AffordabilityAdvice.fromJson({..._manualAdvice, 'somethingNew': true, 'loan': {...(_manualAdvice['loan']! as Map), 'later': 1}});
      expect(future.loan!.id, 'loan_a');
    });

    test('reads and writes calendar days without the phone timezone moving them', () {
      expect(parseCalendarDay('2026-10-30'), DateTime.utc(2026, 10, 30));
      expect(parseCalendarDay('2026-02-30'), isNull);
      expect(parseCalendarDay('30/10/2026'), isNull);
      expect(calendarDayIso(DateTime.utc(2026, 10, 30)), '2026-10-30');
    });
  });

  group('client', () {
    test('lists, adds and closes loans with the bearer token, kobo as strings and counts as numbers', () async {
      final seen = <http.Request>[];
      final api = LedgerApi(
        baseUrl: 'http://100.64.0.8:3000',
        token: 'session-token-value',
        httpClient: MockClient((request) async {
          seen.add(request);
          if (request.method == 'GET') return _json(_loansResponse);
          return _json(_openLoan, request.method == 'POST' ? 201 : 200);
        }),
      );
      expect((await api.loans()).loans, hasLength(2));
      await api.createLoan(
        const LoanDraft(lender: 'Renmoney', outstandingMinor: '125000050', instalmentMinor: '25000000', instalmentsPaid: 3, instalmentsTotal: 8, nextDueDate: '2026-11-30'),
      );
      await api.setLoanStatus('loan_a', 'closed');
      expect(seen.map((r) => '${r.method} ${r.url.path}'), ['GET /api/v1/loans', 'POST /api/v1/loans', 'PATCH /api/v1/loans/loan_a']);
      expect(seen.every((r) => r.headers['Authorization'] == 'Bearer session-token-value'), isTrue);
      expect(jsonDecode(seen[1].body), {
        'lender': 'Renmoney',
        'outstandingMinor': '125000050',
        'instalmentMinor': '25000000',
        'instalmentsPaid': 3,
        'instalmentsTotal': 8,
        'nextDueDate': '2026-11-30',
        'endDate': null,
        'notes': null,
      });
      expect(jsonDecode(seen[2].body), {'status': 'closed'});
    });

    test('a server from before loans gets a plain message, not a parse error', () async {
      final api = LedgerApi(baseUrl: 'http://100.64.0.8:3000', token: 't', httpClient: MockClient((_) async => http.Response('<html>404</html>', 404)));
      await expectLater(api.loans(), throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('does not have Loans yet'))));
      final gone = LedgerApi(baseUrl: 'http://100.64.0.8:3000', token: 't', httpClient: MockClient((_) async => _json({'error': 'Loan not found'}, 404)));
      await expectLater(gone.setLoanStatus('x', 'closed'), throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Loan not found')));
    });
  });

  group('screens', () {
    testWidgets('Afford shows the entered balance on a loan line, and offers to add one when there is none', (tester) async {
      final check = AffordabilityCheck.fromJson({
        ...affordabilityResponse,
        'advice': [_manualAdvice, ...(affordabilityResponse['advice']! as List)],
      });
      final controller = await _signedIn((_) async => _json(_loansResponse));
      await tester.pumpWidget(_app(controller, Scaffold(body: ListView(children: [AffordabilityAnswer(result: check)]))));
      expect(find.textContaining('Clear Renmoney: ₦1.25m left, last payment 30 Mar.'), findsOneWidget);
      expect(find.text('₦1,250,000.50 left · last payment 30 Mar 2027'), findsOneWidget);
      expect(find.text('Update'), findsOneWidget);
      expect(find.byKey(const Key('add-balance-FairMoney')), findsOneWidget);
      expect(find.byKey(const Key('add-balance-Renmoney')), findsNothing);

      await tester.tap(find.byKey(const Key('add-balance-FairMoney')));
      await tester.pumpAndSettle();
      expect(find.text('Add a loan'), findsOneWidget);
      expect(find.text('FairMoney'), findsOneWidget);
      controller.dispose();
    });

    testWidgets('lists loans, flags one the bank shows repayments for, and adds a loan', (tester) async {
      final requests = <http.Request>[];
      final controller = await _signedIn((request) async {
        requests.add(request);
        if (request.method == 'POST') return _json({..._openLoan, 'id': 'loan_c', 'lender': 'PalmCredit'}, 201);
        return _json(_loansResponse);
      });
      await tester.pumpWidget(_app(controller, const LoansScreen()));
      await tester.pumpAndSettle();

      expect(find.text('₦1,250,000.50 left'), findsOneWidget);
      expect(find.text('₦250,000.00 a month · 3 of 8 paid · next due 30 Nov 2026 · last payment 30 Mar 2027'), findsOneWidget);
      expect(find.textContaining('Out of date: your bank shows ₦250,000.00 repaid to Renmoney'), findsOneWidget);
      expect(find.text('Closed'), findsOneWidget);
      expect(find.text('Reopen'), findsOneWidget);

      await tester.tap(find.byKey(const Key('add-loan')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('loan-lender')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('PalmCredit').last);
      await tester.pumpAndSettle();
      await _reveal(tester, 'loan-outstanding');
      await tester.enterText(find.byKey(const Key('loan-outstanding')), '450k');
      await _reveal(tester, 'loan-instalment');
      await tester.enterText(find.byKey(const Key('loan-instalment')), '75,000');
      await _reveal(tester, 'loan-paid');
      await tester.enterText(find.byKey(const Key('loan-paid')), '0');
      await _reveal(tester, 'loan-total');
      await tester.enterText(find.byKey(const Key('loan-total')), '6');
      await _reveal(tester, 'loan-next-due');
      await tester.enterText(find.byKey(const Key('loan-next-due')), '2026-11-15');
      await _reveal(tester, 'save-loan');
      await tester.tap(find.byKey(const Key('save-loan')));
      await tester.pumpAndSettle();

      final post = requests.singleWhere((r) => r.method == 'POST');
      expect(jsonDecode(post.body), {
        'lender': 'PalmCredit',
        'outstandingMinor': '45000000',
        'instalmentMinor': '7500000',
        'instalmentsPaid': 0,
        'instalmentsTotal': 6,
        'nextDueDate': '2026-11-15',
        'endDate': null,
        'notes': null,
      });
      expect(find.text('Loans'), findsOneWidget);
      expect(requests.where((r) => r.method == 'GET'), hasLength(2));
      controller.dispose();
    });

    testWidgets('edits a loan with its figures filled in, and checks the form first', (tester) async {
      final requests = <http.Request>[];
      final controller = await _signedIn((request) async {
        requests.add(request);
        if (request.method == 'PATCH') return _json(_openLoan);
        return _json(_loansResponse);
      });
      await tester.pumpWidget(_app(controller, const LoansScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('edit-loan-loan_a')));
      await tester.pumpAndSettle();

      expect(find.text('Edit Renmoney'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const Key('loan-outstanding'))).controller!.text, '1250000.50');
      expect(tester.widget<TextField>(find.byKey(const Key('loan-next-due'))).controller!.text, '2026-11-30');

      await _reveal(tester, 'loan-paid');
      await tester.enterText(find.byKey(const Key('loan-paid')), '9');
      await _reveal(tester, 'save-loan');
      await tester.tap(find.byKey(const Key('save-loan')));
      await tester.pump();
      expect(find.text('Instalments paid cannot be more than the total.'), findsOneWidget);
      expect(requests.where((r) => r.method == 'PATCH'), isEmpty);

      await _reveal(tester, 'loan-paid');
      await tester.enterText(find.byKey(const Key('loan-paid')), '4');
      await _reveal(tester, 'loan-outstanding');
      await tester.enterText(find.byKey(const Key('loan-outstanding')), '1,000,000.50');
      await _reveal(tester, 'save-loan');
      await tester.tap(find.byKey(const Key('save-loan')));
      await tester.pumpAndSettle();
      final patch = requests.singleWhere((r) => r.method == 'PATCH');
      expect(patch.url.path, '/api/v1/loans/loan_a');
      expect(jsonDecode(patch.body), {
        'lender': 'Renmoney',
        'outstandingMinor': '100000050',
        'instalmentMinor': '25000000',
        'instalmentsPaid': 4,
        'instalmentsTotal': 8,
        'nextDueDate': '2026-11-30',
        'endDate': null,
        'notes': 'Generator loan',
      });
      controller.dispose();
    });
  });
}
