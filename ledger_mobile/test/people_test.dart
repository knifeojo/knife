import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/screens/affordability_screen.dart';
import 'package:ledger_mobile/screens/people_screen.dart';
import 'package:ledger_mobile/screens/review_screen.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:ledger_mobile/theme.dart';

import 'affordability_fixture.dart';

// Synthetic people and narrations only, shaped like GET /api/v1/review and /api/v1/people.
const _narrations = ['TRF TO OJO GIFT A/ MONTHLY UPKEEP/ 0123456789', 'NIP TRANSFER GIFT ADEBAYO OJO FOOD STUFF', 'TRF TO GIFT'];

Map<String, Object?> _option(String value, String label, String category, String group, [String? subcategory]) => {
  'value': value,
  'label': label,
  'category': category,
  'subcategory': subcategory,
  'group': group,
};

final _personQuestion = <String, Object?>{
  'kind': 'person',
  'key': 'gift adebayo ojo',
  'title': 'Who is Gift Adebayo Ojo to you?',
  'prompt': 'You sent ₦150,000 in 3 payments and received ₦20,000 in 1.',
  'totalMinor': '17000000',
  'count': 4,
  'examples': _narrations,
  'options': [
    _option('rel:spouse', 'Spouse / partner', 'Family', 'relationship', 'Spouse'),
    _option('rel:sibling', 'Sibling', 'Family', 'relationship', 'Siblings'),
    _option('rel:parent', 'Parent', 'Family', 'relationship', 'Parents'),
    _option('rel:child', 'Child', 'Family', 'relationship', 'Children'),
    _option('rel:extended', 'Extended family (black tax)', 'Family', 'relationship', 'Black tax'),
    _option('rel:friend', 'Friend', 'Transfers', 'relationship', 'Gifts & lending'),
    _option('rel:vendor', 'Vendor / service provider', '', 'relationship'),
    _option('rel:colleague', 'Colleague / work', 'Transfers', 'relationship'),
    _option('rel:me', 'Me (my own other account)', 'Own transfer', 'relationship'),
    _option('rel:other', 'Someone else', '', 'relationship'),
    _option('family', 'Family', 'Family', 'more'),
    _option('unknown', 'Skip', '', 'control'),
    _option('not_person', 'Not a person', '', 'control'),
  ],
  'currentCategory': 'Transfers',
  'hint': 'The name looks like a person',
  'narrationHints': [],
  'allowsOther': true,
  'person': {
    'inCount': 1,
    'inMinor': '2000000',
    'outCount': 3,
    'outMinor': '15000000',
    'lastDate': '2026-09-30',
    'variants': ['Gift Adebayo Ojo', 'Ojo Gift A', 'Gift'],
  },
  'impactMinor': '17000000',
  'aiRelationship': 'spouse',
  'guess': {
    'kind': 'two_way',
    'reason': 'Money goes both ways between you. A friend?',
    'answers': [
      {'value': 'rel:friend', 'label': 'Friend', 'vendorCategory': null, 'vendorSubcategory': null},
    ],
  },
};

final _reviewWithPerson = <String, Object?>{
  'questions': [_personQuestion],
  'totalMinor': '17000000',
  'categories': ['Family', 'Food', 'Personal care', 'Transfers'],
};

Map<String, Object?> _gift({String relationship = 'spouse', String label = 'Spouse / partner', List<Map<String, Object?>>? aliases}) => {
  'id': 'p_gift',
  'displayName': 'Gift Adebayo Ojo',
  'relationship': relationship,
  'relationshipLabel': label,
  'note': null,
  'vendorCategory': null,
  'vendorSubcategory': null,
  'aliases':
      aliases ??
      [
        {'name': 'Gift Adebayo Ojo', 'rejected': false},
        {'name': 'Ojo Gift A', 'rejected': false},
      ],
  'category': 'Family',
  'subcategory': relationship == 'spouse' ? 'Spouse' : 'Siblings',
  'count': 4,
  'inMinor': '2000000',
  'outMinor': '15000000',
  'lastDate': '2026-09-30',
  'months': [
    {'month': '2026-09', 'inMinor': '0', 'outMinor': '10000000'},
    {'month': '2026-08', 'inMinor': '2000000', 'outMinor': '5000000'},
  ],
};

final _tunde = <String, Object?>{
  'id': 'p_tunde',
  'displayName': 'Tunde Ojo',
  'relationship': 'sibling',
  'relationshipLabel': 'Sibling',
  'aliases': [
    {'name': 'Tunde Ojo', 'rejected': false},
  ],
  'category': 'Family',
  'subcategory': 'Siblings',
  'count': 2,
  'inMinor': '0',
  'outMinor': '6000000',
  'lastDate': '2026-09-12',
  'months': [
    {'month': '2026-09', 'inMinor': '0', 'outMinor': '6000000'},
  ],
};

const _relationships = [
  {'value': 'spouse', 'label': 'Spouse / partner'},
  {'value': 'sibling', 'label': 'Sibling'},
  {'value': 'parent', 'label': 'Parent'},
  {'value': 'other', 'label': 'Someone else'},
];

Map<String, Object?> _peopleList(List<Map<String, Object?>> people, {Map<String, Object?>? undo, bool choices = true}) => {
  'people': people,
  'undo': undo,
  if (choices) 'relationships': _relationships,
  if (choices) 'categories': ['Family', 'Food', 'Transfers'],
};

http.Response _json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

Future<LedgerController> _signedIn(Future<http.Response> Function(http.Request request) handler) async {
  final controller = LedgerController(MemorySettingsStore(), httpClient: MockClient(handler));
  await controller.load();
  controller.serverUrl = 'http://100.64.0.8:3000';
  controller.token = 'token-token-token-token';
  return controller;
}

/// A phone-height window, so whole cards fit and taps land on screen.
void _tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 3600);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Widget _app(LedgerController controller, Widget home) {
  return ChangeNotifierProvider<LedgerController>.value(
    value: controller,
    child: MaterialApp(theme: ledgerTheme(Brightness.light), home: home),
  );
}

void main() {
  group('models', () {
    test('a person question carries money both ways, the bank spellings and the AI guess', () {
      final q = ReviewQuestion.fromJson(_personQuestion);
      expect(q.isPerson, isTrue);
      expect(q.person!.outMinor, '15000000');
      expect(q.person!.inCount, 1);
      expect(q.person!.variants, ['Gift Adebayo Ojo', 'Ojo Gift A', 'Gift']);
      expect(q.aiRelationship, 'spouse');
      expect(q.guess!.kind, 'two_way');
      expect(q.options.where((o) => o.group == 'relationship'), hasLength(10));
    });

    test('older Review questions are not person questions', () {
      final q = ReviewQuestion.fromJson({
        ..._personQuestion,
        'person': null,
        'options': [
          {'value': 'family', 'label': 'Family', 'category': 'Family'},
        ],
      });
      expect(q.isPerson, isFalse);
      expect(q.options.single.group, isNull);
    });

    test('people list parses totals per month and keeps choices across writes', () {
      final first = PeopleList.fromJson(_peopleList([_gift()]));
      final p = first.people.single;
      expect(p.label, 'Family / Spouse');
      expect(p.months.first.month, '2026-09');
      expect(p.months.first.outMinor, '10000000');
      expect(p.aliases.map((a) => a.name), ['Gift Adebayo Ojo', 'Ojo Gift A']);
      final next = PeopleList.fromJson(_peopleList([_gift(), _tunde], choices: false)).withChoicesFrom(first);
      expect(next.people, hasLength(2));
      expect(next.relationships.map((r) => r.value), contains('sibling'));
      expect(next.categories, ['Family', 'Food', 'Transfers']);
    });

    test('affordability lists family obligations, and older servers send none', () {
      final withFamily = AffordabilityCheck.fromJson({
        ...affordabilityResponse,
        'inputs': {
          ...(affordabilityResponse['inputs'] as Map<String, Object?>),
          'familyObligations': [
            {'label': 'Family / Black tax', 'monthlyMinor': '5000000', 'months': 3, 'recurring': true},
          ],
        },
      });
      expect(withFamily.familyObligations.single.label, 'Family / Black tax');
      expect(AffordabilityCheck.fromJson(affordabilityResponse).familyObligations, isEmpty);
    });
  });

  group('Who is … to you?', () {
    testWidgets('shows totals both ways, sample narrations and one-tap relationships with the AI guess highlighted', (tester) async {
      final posts = <Object?>[];
      final controller = await _signedIn((request) async {
        if (request.method == 'POST') {
          posts.add(jsonDecode(request.body));
          return _json({'updated': 4});
        }
        return _json(posts.isEmpty ? _reviewWithPerson : {'questions': [], 'totalMinor': '0', 'categories': []});
      });
      _tall(tester);
      await tester.pumpWidget(_app(controller, const ReviewScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Who is Gift Adebayo Ojo to you?'), findsOneWidget);
      expect(find.text('Paid out ₦150,000.00 in 3 · Received ₦20,000.00 in 1 · last 2026-09-30'), findsOneWidget);
      expect(find.text('Also written as: Ojo Gift A, Gift'), findsOneWidget);
      expect(tester.widgetList<SelectableText>(find.byType(SelectableText)).map((t) => t.data), _narrations);
      expect(find.text('Money goes both ways between you. A friend?'), findsOneWidget);
      expect(find.text('AI thinks: Spouse / partner. Tap it to confirm.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Spouse / partner'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Sibling'), findsOneWidget);
      expect(find.byKey(const Key('rel-extended')), findsOneWidget);
      expect(find.byKey(const Key('rel-me')), findsOneWidget);
      // "Someone else" and the older detailed answers wait behind a tap.
      expect(find.byKey(const Key('rel-other')), findsNothing);
      expect(find.byKey(const Key('skip-gift adebayo ojo')), findsOneWidget);
      expect(find.byKey(const Key('not-person-gift adebayo ojo')), findsOneWidget);

      await tester.ensureVisible(find.byKey(const Key('rel-spouse')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('rel-spouse')));
      await tester.pumpAndSettle();
      expect(posts, [
        {'kind': 'person', 'key': 'gift adebayo ojo', 'value': 'rel:spouse'},
      ]);
      expect(find.textContaining('Saved to Your people. 4 payments relabelled.'), findsOneWidget);
      controller.dispose();
    });

    testWidgets('a vendor is asked what they are paid for', (tester) async {
      final posts = <Object?>[];
      final controller = await _signedIn((request) async {
        if (request.method == 'POST') {
          posts.add(jsonDecode(request.body));
          return _json({'updated': 3});
        }
        return _json(_reviewWithPerson);
      });
      _tall(tester);
      await tester.pumpWidget(_app(controller, const ReviewScreen()));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byKey(const Key('rel-vendor')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('rel-vendor')));
      await tester.pumpAndSettle();
      expect(find.text('What do you pay them for?'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('vendor-save'))).onPressed, isNull);
      await tester.tap(find.byKey(const Key('vendor-category')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Personal care').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('vendor-what')), 'hair');
      await tester.tap(find.byKey(const Key('vendor-save')));
      await tester.pumpAndSettle();
      expect(posts, [
        {'kind': 'person', 'key': 'gift adebayo ojo', 'value': 'rel:vendor', 'vendorCategory': 'Personal care', 'vendorSubcategory': 'hair'},
      ]);
      controller.dispose();
    });

    testWidgets('Someone else, Skip and Not a person', (tester) async {
      final posts = <Object?>[];
      final controller = await _signedIn((request) async {
        if (request.method == 'POST') {
          posts.add(jsonDecode(request.body));
          return _json({'updated': 0});
        }
        return _json(_reviewWithPerson);
      });
      _tall(tester);
      await tester.pumpWidget(_app(controller, const ReviewScreen()));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byKey(const Key('someone-else-gift adebayo ojo')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('someone-else-gift adebayo ojo')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('rel-other')), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Family'), findsOneWidget);
      expect(find.byKey(const Key('other-gift adebayo ojo')), findsOneWidget);

      await tester.ensureVisible(find.byKey(const Key('not-person-gift adebayo ojo')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('not-person-gift adebayo ojo')));
      await tester.pumpAndSettle();
      expect(find.text('Ledger will not ask about this name as a person again.'), findsOneWidget);
      tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger)).clearSnackBars();
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('skip-gift adebayo ojo')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('skip-gift adebayo ojo')));
      await tester.pumpAndSettle();
      expect(posts.map((p) => (p as Map)['value']), ['not_person', 'unknown']);
      controller.dispose();
    });
  });

  group('Your people', () {
    testWidgets('lists people with their label, totals per month and bank spellings', (tester) async {
      final controller = await _signedIn((request) async => _json(_peopleList([_gift(), _tunde])));
      _tall(tester);
      await tester.pumpWidget(_app(controller, const PeopleScreen()));
      await tester.pumpAndSettle();

      expect(find.widgetWithText(Row, 'Gift Adebayo Ojo'), findsOneWidget);
      expect(find.text('Labelled Family / Spouse'), findsOneWidget);
      expect(find.text('Paid ₦150,000.00 · Received ₦20,000.00 · 4 payments · last 2026-09-30'), findsOneWidget);
      expect(find.byKey(const Key('months-p_gift')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const Key('months-p_gift')), matching: find.text('₦100,000.00')), findsOneWidget);
      expect(find.byKey(const Key('alias-p_gift-Ojo Gift A')), findsOneWidget);
      expect(find.widgetWithText(ActionChip, 'Spouse / partner'), findsOneWidget);
      expect(find.byKey(const Key('merge-p_gift')), findsOneWidget);
      expect(find.byKey(const Key('people-undo')), findsNothing);
      controller.dispose();
    });

    testWidgets('adds family from plain sentences', (tester) async {
      final requests = <http.Request>[];
      final controller = await _signedIn((request) async {
        requests.add(request);
        if (request.method == 'POST') {
          return _json({
            'added': 2,
            'updated': 6,
            'unread': ['my plumber'],
            ..._peopleList([_gift(), _tunde], choices: false, undo: {'batchId': 'b1', 'label': 'Added 2 people', 'changed': 6}),
          }, 201);
        }
        return _json(_peopleList([]));
      });
      _tall(tester);
      await tester.pumpWidget(_app(controller, const PeopleScreen()));
      await tester.pumpAndSettle();
      expect(find.textContaining('No people yet.'), findsOneWidget);

      await tester.tap(find.byKey(const Key('people-add')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('people-text')), 'My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo\nmy plumber');
      await tester.tap(find.byKey(const Key('people-text-save')));
      await tester.pumpAndSettle();

      expect(requests.last.url.path, '/api/v1/people');
      expect(jsonDecode(requests.last.body), {'text': 'My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo\nmy plumber'});
      expect(find.byKey(const Key('person-p_gift')), findsOneWidget);
      expect(find.byKey(const Key('person-p_tunde')), findsOneWidget);
      expect(find.textContaining('Could not read: my plumber.'), findsOneWidget);
      expect(find.byKey(const Key('people-undo')), findsOneWidget);
      expect(find.text('Added 2 people'), findsOneWidget);
      controller.dispose();
    });

    testWidgets('changes a relationship, rejects a spelling, merges and undoes', (tester) async {
      final writes = <List<Object?>>[];
      final controller = await _signedIn((request) async {
        if (request.method == 'GET') return _json(_peopleList([_gift(), _tunde]));
        writes.add([request.method, request.url.path, request.body.isEmpty ? null : jsonDecode(request.body)]);
        final undo = {'batchId': 'b${writes.length}', 'label': 'Changed', 'changed': 4};
        if (request.url.path.endsWith('/undo')) return _json(_peopleList([_gift(), _tunde], choices: false));
        if (request.url.path.endsWith('/merge')) {
          return _json({'updated': 2, ..._peopleList([_gift()], choices: false, undo: undo)});
        }
        return _json({
          'updated': 4,
          ..._peopleList(
            [_gift(relationship: 'sibling', label: 'Sibling'), _tunde],
            choices: false,
            undo: undo,
          ),
        });
      });
      _tall(tester);
      await tester.pumpWidget(_app(controller, const PeopleScreen()));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('relationship-p_gift')));
      await tester.pumpAndSettle();
      expect(find.text('Spouse / partner (now)'), findsOneWidget);
      await tester.tap(find.byKey(const Key('choose-sibling')));
      await tester.pumpAndSettle();
      expect(writes.last, [
        'PATCH',
        '/api/v1/people/p_gift',
        {'relationship': 'sibling'},
      ]);
      expect(find.text('Updated Gift Adebayo Ojo.'), findsOneWidget);
      expect(find.byKey(const Key('people-undo')), findsOneWidget);

      // The relationship choices from GET survive a write that returns only people.
      await tester.tap(find.byKey(const Key('relationship-p_gift')));
      await tester.pumpAndSettle();
      expect(find.text('Sibling (now)'), findsOneWidget);
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byKey(const Key('alias-p_gift-Ojo Gift A')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('alias-p_gift-Ojo Gift A')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('alias-reject')));
      await tester.pumpAndSettle();
      expect(writes.last, [
        'PATCH',
        '/api/v1/people/p_gift',
        {
          'rejectAliases': ['Ojo Gift A'],
        },
      ]);

      await tester.ensureVisible(find.byKey(const Key('alias-add-p_gift')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('alias-add-p_gift')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('alias-text')), 'TRF TO GIFT ');
      await tester.tap(find.byKey(const Key('alias-save')));
      await tester.pumpAndSettle();
      expect(writes.last, [
        'PATCH',
        '/api/v1/people/p_gift',
        {
          'addAliases': ['TRF TO GIFT'],
        },
      ]);

      await tester.ensureVisible(find.byKey(const Key('merge-p_gift')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('merge-p_gift')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('merge-into-p_tunde')));
      await tester.pumpAndSettle();
      expect(writes.last, [
        'POST',
        '/api/v1/people/merge',
        {'targetId': 'p_gift', 'sourceId': 'p_tunde'},
      ]);
      expect(find.byKey(const Key('person-p_tunde')), findsNothing);

      await tester.tap(find.byKey(const Key('people-undo-button')));
      await tester.pumpAndSettle();
      expect(writes.last, [
        'POST',
        '/api/v1/people/undo',
        {'batchId': 'b4'},
      ]);
      expect(find.byKey(const Key('person-p_tunde')), findsOneWidget);
      expect(find.byKey(const Key('people-undo')), findsNothing);
      controller.dispose();
    });

    testWidgets('removes a person after confirming', (tester) async {
      final writes = <String>[];
      final controller = await _signedIn((request) async {
        if (request.method == 'DELETE') {
          writes.add(request.url.path);
          return _json({
            'updated': 2,
            ..._peopleList([_gift()], choices: false, undo: {'batchId': 'b1', 'label': 'Removed Tunde Ojo', 'changed': 2}),
          });
        }
        return _json(_peopleList([_gift(), _tunde]));
      });
      _tall(tester);
      await tester.pumpWidget(_app(controller, const PeopleScreen()));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('delete-p_tunde')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('delete-p_tunde')));
      await tester.pumpAndSettle();
      expect(find.textContaining('You can undo this.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('delete-confirm')));
      await tester.pumpAndSettle();
      expect(writes, ['/api/v1/people/p_tunde']);
      expect(find.byKey(const Key('person-p_tunde')), findsNothing);
      expect(find.text('Removed Tunde Ojo'), findsOneWidget);
      controller.dispose();
    });

    testWidgets('an older server without People gets a clear message', (tester) async {
      final controller = await _signedIn((request) async => http.Response('<html>Not found</html>', 404));
      _tall(tester);
      await tester.pumpWidget(_app(controller, const PeopleScreen()));
      await tester.pumpAndSettle();
      expect(find.textContaining('does not have Your people yet'), findsOneWidget);
      controller.dispose();
    });
  });

  testWidgets('Afford shows family support as an obligation', (tester) async {
    final result = AffordabilityCheck.fromJson({
      ...affordabilityResponse,
      'inputs': {
        ...(affordabilityResponse['inputs'] as Map<String, Object?>),
        'familyObligations': [
          {'label': 'Family / Black tax', 'monthlyMinor': '5000000', 'months': 3, 'recurring': true},
          {'label': 'Family / Spouse', 'monthlyMinor': '8000000', 'months': 1, 'recurring': false},
        ],
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: ledgerTheme(Brightness.light),
        home: Scaffold(
          body: ListView(children: [AffordabilityAnswer(result: result)]),
        ),
      ),
    );
    expect(find.byKey(const Key('afford-family')), findsOneWidget);
    expect(find.textContaining('not something to cut'), findsOneWidget);
    expect(find.text('Family / Black tax, every month'), findsOneWidget);
    expect(find.text('Family / Spouse, in 1 month'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('afford-family')), matching: find.text('₦50,000.00')), findsOneWidget);
  });
}
