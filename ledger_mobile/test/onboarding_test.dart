import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/screens/onboarding_screen.dart';
import 'package:ledger_mobile/screens/review_screen.dart';
import 'package:ledger_mobile/screens/top_people_screen.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:ledger_mobile/theme.dart';

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

Future<LedgerController> _signedIn(Future<http.Response> Function(http.Request request) handler) async {
  final controller = LedgerController(MemorySettingsStore(), httpClient: MockClient(handler));
  await controller.load();
  controller.serverUrl = 'http://100.64.0.8:3000';
  controller.token = 'token-token-token-token';
  return controller;
}

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

final _statuses = [
  {'value': 'single', 'label': 'Single'},
  {'value': 'married', 'label': 'Married'},
  {'value': 'engaged', 'label': 'Engaged'},
  {'value': 'relationship', 'label': 'In a relationship'},
  {'value': 'private', 'label': 'Prefer not to say'},
];

final _onboarding = <String, Object?>{
  'needsOnboarding': true,
  'ownName': null,
  'relationshipStatus': null,
  'statuses': _statuses,
  'trustNote': 'These names stay on your device and are never sent to the cloud.',
  'topPeople': {'show': false, 'people': []},
  'relationships': [
    {'value': 'spouse', 'label': 'Spouse / partner'},
    {'value': 'parent', 'label': 'Parent'},
  ],
};

final _topPeople = <String, Object?>{
  'needsOnboarding': false,
  'ownName': 'Ada Okonkwo',
  'relationshipStatus': 'married',
  'statuses': _statuses,
  'trustNote': 'These names stay on your device and are never sent to the cloud.',
  'topPeople': {
    'show': true,
    'people': [
      {
        'key': 'chidi okonkwo',
        'display': 'Chidi Okonkwo',
        'person': {
          'inCount': 0,
          'inMinor': '0',
          'outCount': 2,
          'outMinor': '30000000',
          'lastDate': '2026-09-02',
          'variants': ['Chidi Okonkwo'],
        },
        'guess': {
          'kind': 'same_surname',
          'reason': 'They share your surname, Okonkwo. Family?',
          'answers': [
            {'value': 'rel:sibling', 'label': 'Sibling'},
            {'value': 'rel:parent', 'label': 'Parent'},
          ],
        },
      },
    ],
  },
  'relationships': [
    {'value': 'spouse', 'label': 'Spouse / partner'},
  ],
};

void main() {
  test('onboarding JSON keeps the trust note and top people', () {
    final state = OnboardingState.fromJson(_topPeople);
    expect(state.needsOnboarding, isFalse);
    expect(state.showTopPeople, isTrue);
    expect(state.topPeople.single.display, 'Chidi Okonkwo');
    expect(state.topPeople.single.guess!.kind, 'same_surname');
    expect(state.trustNote, contains('never sent to the cloud'));
  });

  testWidgets('the first-run form saves names and can be skipped', (tester) async {
    final posts = <Object?>[];
    final controller = await _signedIn((request) async {
      if (request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        return _json({..._onboarding, 'needsOnboarding': false, 'added': 3});
      }
      return _json(_onboarding);
    });
    _tall(tester);
    await tester.pumpWidget(_app(controller, const OnboardingScreen()));
    await tester.pumpAndSettle();

    expect(find.text('Who are your people?'), findsOneWidget);
    expect(find.textContaining('never sent to the cloud'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('onboard-name')), 'Ada Okonkwo');
    await tester.tap(find.byKey(const Key('status-married')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('onboard-partner')), 'Chidi Okonkwo');
    await tester.enterText(find.byKey(const Key('onboard-parents')), 'Eze Okonkwo, Ngozi Okonkwo');
    await tester.tap(find.byKey(const Key('onboard-save')));
    await tester.pumpAndSettle();
    expect(posts.single, {
      'ownName': 'Ada Okonkwo',
      'relationshipStatus': 'married',
      'partner': 'Chidi Okonkwo',
      'parents': 'Eze Okonkwo, Ngozi Okonkwo',
    });
    controller.dispose();
  });

  testWidgets('Skip sends skip: true', (tester) async {
    final posts = <Object?>[];
    final controller = await _signedIn((request) async {
      if (request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        return _json({..._onboarding, 'needsOnboarding': false});
      }
      return _json(_onboarding);
    });
    _tall(tester);
    await tester.pumpWidget(_app(controller, const OnboardingScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('onboard-skip')));
    await tester.pumpAndSettle();
    expect(posts.single, {'skip': true});
    controller.dispose();
  });

  testWidgets('top people offers one-tap guesses and Done', (tester) async {
    final posts = <Object?>[];
    final controller = await _signedIn((request) async {
      if (request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        if (request.url.path.endsWith('/review')) return _json({'updated': 2});
        return _json({..._topPeople, 'topPeople': {'show': false, 'people': []}});
      }
      return _json(_topPeople);
    });
    _tall(tester);
    await tester.pumpWidget(_app(controller, TopPeopleScreen(initial: OnboardingState.fromJson(_topPeople))));
    await tester.pumpAndSettle();

    expect(find.text('You send money to these people most. Who are they?'), findsOneWidget);
    expect(find.text('They share your surname, Okonkwo. Family?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('top-chidi okonkwo-Sibling')));
    await tester.pumpAndSettle();
    expect(posts.first, {'kind': 'person', 'key': 'chidi okonkwo', 'value': 'rel:sibling'});
    controller.dispose();
  });

  testWidgets('a Review guess is one tap', (tester) async {
    final posts = <Object?>[];
    final question = <String, Object?>{
      'kind': 'person',
      'key': 'chidi okonkwo',
      'title': 'Who is Chidi Okonkwo to you?',
      'prompt': 'You sent 2 payments.',
      'totalMinor': '30000000',
      'count': 2,
      'examples': ['TRF TO CHIDI OKONKWO'],
      'options': [
        {'value': 'rel:sibling', 'label': 'Sibling', 'category': 'Family', 'subcategory': 'Siblings', 'group': 'relationship'},
        {'value': 'unknown', 'label': 'Skip', 'category': '', 'group': 'control'},
      ],
      'narrationHints': [],
      'allowsOther': true,
      'person': {
        'inCount': 0,
        'inMinor': '0',
        'outCount': 2,
        'outMinor': '30000000',
        'lastDate': '2026-09-02',
        'variants': ['Chidi Okonkwo'],
      },
      'guess': {
        'kind': 'same_surname',
        'reason': 'They share your surname, Okonkwo. Family?',
        'answers': [
          {'value': 'rel:sibling', 'label': 'Sibling'},
        ],
      },
    };
    final controller = await _signedIn((request) async {
      if (request.method == 'POST') {
        posts.add(jsonDecode(request.body));
        return _json({'updated': 2});
      }
      return _json({
        'questions': [question],
        'totalMinor': '30000000',
        'categories': ['Family'],
      });
    });
    _tall(tester);
    await tester.pumpWidget(_app(controller, const ReviewScreen()));
    await tester.pumpAndSettle();
    expect(find.text('They share your surname, Okonkwo. Family?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('guess-chidi okonkwo-Sibling')));
    await tester.pumpAndSettle();
    expect(posts.single, {'kind': 'person', 'key': 'chidi okonkwo', 'value': 'rel:sibling'});
    controller.dispose();
  });
}
