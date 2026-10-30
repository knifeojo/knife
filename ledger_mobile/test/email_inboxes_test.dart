import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:ledger_mobile/screens/email_inboxes_card.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';

void main() {
  testWidgets('Settings lists inboxes and Add email opens Sign in with Google', (tester) async {
    final opened = <String>[];
    final deleted = <String>[];
    var yahoo = true;
    final controller = LedgerController(
      MemorySettingsStore(),
      httpClient: MockClient((request) async {
        if (request.url.path == '/api/v1/email/connections' && request.method == 'GET') {
          return _json({
            'connections': [
              {'id': 'gmail-1', 'provider': 'gmail', 'address': 'ada@example.test'},
              if (yahoo) {'id': 'yahoo-1', 'provider': 'imap', 'address': 'ada@yahoo.test'},
            ],
          });
        }
        if (request.url.path == '/api/v1/email/google/start') {
          return _json({
            'url': 'https://accounts.google.com/o/oauth2/v2/auth?scope=https://www.googleapis.com/auth/gmail.readonly&access_type=offline',
          });
        }
        if (request.method == 'DELETE' && request.url.path == '/api/v1/email/connections/yahoo-1') {
          deleted.add(request.url.path);
          yahoo = false;
          return _json({'ok': true});
        }
        return _json({'connections': [
          {'id': 'gmail-1', 'provider': 'gmail', 'address': 'ada@example.test'},
        ]});
      }),
    );
    await controller.load();
    controller.serverUrl = 'http://100.64.0.8:3000';
    controller.token = 'token-token-token-token';

    await tester.pumpWidget(
      ChangeNotifierProvider<LedgerController>.value(
        value: controller,
        child: MaterialApp(
          home: Scaffold(body: EmailInboxesCard(openUrl: (url) async => opened.add(url))),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Gmail · ada@example.test'), findsOneWidget);
    expect(find.text('IMAP · ada@yahoo.test'), findsOneWidget);
    expect(find.text('Add email'), findsOneWidget);

    await tester.tap(find.byKey(const Key('add-email')));
    await tester.pumpAndSettle();
    expect(opened.single, contains('gmail.readonly'));
    expect(opened.single, contains('access_type=offline'));
    expect(find.textContaining('Sign in with Google'), findsWidgets);

    await tester.tap(find.byKey(const Key('email-remove-yahoo-1')));
    await tester.pumpAndSettle();
    expect(deleted, ['/api/v1/email/connections/yahoo-1']);
    expect(find.text('IMAP · ada@yahoo.test'), findsNothing);
    controller.dispose();
  });

  testWidgets('Add email shows not configured when Google is unset', (tester) async {
    final controller = LedgerController(
      MemorySettingsStore(),
      httpClient: MockClient((request) async {
        if (request.url.path == '/api/v1/email/google/start') {
          return http.Response(
            jsonEncode({'error': 'Google sign-in is not configured.'}),
            503,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        return _json({'connections': []});
      }),
    );
    await controller.load();
    controller.serverUrl = 'http://100.64.0.8:3000';
    controller.token = 'token-token-token-token';
    await tester.pumpWidget(
      ChangeNotifierProvider<LedgerController>.value(
        value: controller,
        child: const MaterialApp(home: Scaffold(body: EmailInboxesCard())),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('add-email')));
    await tester.pumpAndSettle();
    expect(find.textContaining('not configured'), findsWidgets);
    controller.dispose();
  });

  testWidgets('Add email explains itself when the Android plugin is missing', (tester) async {
    final controller = LedgerController(
      MemorySettingsStore(),
      httpClient: MockClient((request) async {
        if (request.url.path == '/api/v1/email/google/start') {
          return _json({'url': 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.readonly'});
        }
        return _json({'connections': []});
      }),
    );
    await controller.load();
    controller.serverUrl = 'http://100.64.0.8:3000';
    controller.token = 'token-token-token-token';
    await tester.pumpWidget(
      ChangeNotifierProvider<LedgerController>.value(
        value: controller,
        child: MaterialApp(
          home: Scaffold(
            body: EmailInboxesCard(openUrl: (_) => Future<void>.error(MissingPluginException('ledger/email'))),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('No inboxes connected yet.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('add-email')));
    await tester.pumpAndSettle();
    expect(find.text('Add email runs on the Android app.'), findsOneWidget);
    controller.dispose();
  });
}

http.Response _json(Object body) =>
    http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});
