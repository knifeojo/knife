import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ledger_mobile/alerts/queue.dart';
import 'package:ledger_mobile/alerts/senders.dart';
import 'package:ledger_mobile/alerts/sms_controller.dart';
import 'package:ledger_mobile/alerts/sms_platform.dart';
import 'package:ledger_mobile/alerts/source_id.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/screens/settings_screen.dart';
import 'package:ledger_mobile/screens/sms_alerts_card.dart';
import 'package:ledger_mobile/state/ledger_controller.dart';
import 'package:ledger_mobile/storage/settings_store.dart';
import 'package:provider/provider.dart';

import 'intelligence_fixture.dart';

const _body =
    'Acct:******1234\nAmt:NGN3,450.00 DR\nDesc:POS PURCHASE\nBal:NGN10,000.00';

void main() {
  testWidgets(
    'turning SMS bank alerts on explains, asks, and sets the opt-in only when granted',
    (tester) async {
      final platform = FakeSmsPlatform();
      final sms = _controller(platform);
      await tester.pumpWidget(_card(sms));
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('sms-alerts-toggle')))
            .value,
        isFalse,
      );
      expect(find.text('Last SMS sync: never'), findsOneWidget);
      expect(find.text('Captured 0 · Sent 0'), findsOneWidget);

      await tester.tap(find.byKey(const Key('sms-alerts-toggle')));
      await tester.pumpAndSettle();
      for (final name in [
        'GTBank',
        'GTWorld',
        'FirstBank',
        'Sterling',
        'Providus',
      ]) {
        expect(find.textContaining(name), findsWidgets);
      }
      await tester.tap(find.byKey(const Key('sms-explain-cancel')));
      await tester.pumpAndSettle();
      expect(platform.requests, 0);
      expect(platform.optIn, isFalse);

      await tester.tap(find.byKey(const Key('sms-alerts-toggle')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('sms-explain-continue')));
      await tester.pumpAndSettle();
      expect(platform.requests, 1);
      expect(platform.optIn, isTrue);
      expect(find.text('Import this month?'), findsOneWidget);
      expect(find.textContaining('1 October 2026'), findsOneWidget);
      expect(find.textContaining(smsBankSenderPhrase), findsWidgets);

      await tester.tap(find.byKey(const Key('sms-backfill-no')));
      await tester.pumpAndSettle();
      expect(platform.importedFrom, isNull);
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('sms-alerts-toggle')))
            .value,
        isTrue,
      );

      await tester.tap(find.byKey(const Key('sms-alerts-toggle')));
      await tester.pumpAndSettle();
      expect(platform.optIn, isFalse);

      await tester.tap(find.byKey(const Key('sms-alerts-toggle')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('sms-explain-continue')));
      await tester.pumpAndSettle();
      expect(find.text('Import this month?'), findsNothing);
      expect(platform.optIn, isTrue);
      sms.dispose();
    },
  );

  testWidgets(
    'first enable can import this month and only bank SMS are uploaded',
    (tester) async {
      final platform = FakeSmsPlatform();
      final at = DateTime.utc(2026, 10, 4, 8, 30);
      final body = _body;
      platform.inbox.add(
        QueuedSms(
          sender: 'GTBank',
          body: body,
          receivedAt: at,
          sourceId: smsSourceId(sender: 'GTBank', body: body, receivedAt: at),
        ),
      );
      platform.inbox.add(
        QueuedSms(
          sender: '08031234567',
          body: 'See you at 6',
          receivedAt: at,
          sourceId: 'phone-1',
        ),
      );
      final posted = <QueuedSms>[];
      final sms = _controller(
        platform,
        upload: (batch) async {
          posted.addAll(batch);
          return List.filled(batch.length, true);
        },
      );
      await tester.pumpWidget(_card(sms));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('sms-alerts-toggle')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('sms-explain-continue')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('sms-backfill-yes')));
      await tester.pumpAndSettle();

      expect(platform.importedFrom, DateTime(2026, 10, 1));
      expect(platform.importedTo, DateTime(2026, 10, 28, 18, 4));
      expect(posted, hasLength(1));
      expect(posted.single.sender, 'GTBank');
      expect(posted.single.body, body);
      expect(
        posted.single.receivedAt.toUtc().toIso8601String(),
        '2026-10-04T08:30:00.000Z',
      );
      expect(
        posted.single.sourceId,
        smsSourceId(sender: 'GTBank', body: body, receivedAt: at),
      );
      expect(find.text('Captured 1 · Sent 1'), findsOneWidget);
      expect(
        find.text(smsLastSyncLabel(DateTime(2026, 10, 28, 18, 4))),
        findsOneWidget,
      );
      expect(find.text('Imported 1 bank SMS from this month.'), findsOneWidget);
      sms.dispose();
    },
  );

  testWidgets('a failed upload stays queued', (tester) async {
    final platform = FakeSmsPlatform();
    final at = DateTime.utc(2026, 10, 8, 9);
    platform.inbox.add(
      _queued(
        'Sterling',
        'Money Out! You have spent, NGN4.00 at SHOP from ******4321 at 2026-10-08 09:00:00. You have NGN5.00',
        at,
      ),
    );
    final sms = _controller(
      platform,
      upload: (batch) async => throw const ApiException(0, 'offline'),
    );
    await tester.pumpWidget(_card(sms));
    await tester.pumpAndSettle();
    await _enable(tester);
    await tester.tap(find.byKey(const Key('sms-backfill-yes')));
    await tester.pumpAndSettle();

    expect(find.text('Captured 1 · Sent 0 · 1 waiting'), findsOneWidget);
    expect(find.text('Last SMS sync: never'), findsOneWidget);
    expect(sms.queued, 1);
    sms.dispose();
  });

  testWidgets('denied permission leaves the switch off', (tester) async {
    final platform = FakeSmsPlatform()..permission = SmsPermission.denied;
    final sms = _controller(platform);
    await tester.pumpWidget(_card(sms));
    await tester.pumpAndSettle();
    await _enable(tester);
    expect(find.textContaining('not granted'), findsOneWidget);
    expect(platform.optIn, isFalse);
    expect(find.text('Import this month?'), findsNothing);
    expect(
      tester
          .widget<SwitchListTile>(find.byKey(const Key('sms-alerts-toggle')))
          .value,
      isFalse,
    );
    sms.dispose();
  });

  testWidgets('permanently denied permission links to app settings', (
    tester,
  ) async {
    final platform = FakeSmsPlatform()
      ..permission = SmsPermission.permanentlyDenied;
    final sms = _controller(platform);
    await tester.pumpWidget(_card(sms));
    await tester.pumpAndSettle();
    await _enable(tester);
    expect(find.text('SMS permission is blocked'), findsOneWidget);
    expect(platform.requests, 0);
    await tester.tap(find.byKey(const Key('sms-open-settings')));
    await tester.pumpAndSettle();
    expect(platform.settingsOpens, 1);
    expect(platform.optIn, isFalse);
    sms.dispose();
  });

  testWidgets(
    'Bank alerts shows the switch, counts, and Sync now sends the queue',
    (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final platform = FakeSmsPlatform();
      final posted = <QueuedSms>[];
      final sms = _controller(
        platform,
        upload: (batch) async {
          posted.addAll(batch);
          return List.filled(batch.length, true);
        },
      );
      final seen = <String>[];
      final controller = LedgerController(
        MemorySettingsStore(),
        httpClient: MockClient((request) async {
          seen.add('${request.method} ${request.url.path}');
          if (request.url.path == '/api/v1/alerts/sync') {
            return http.Response(
              '{}',
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          if (request.url.path == '/api/v1/alerts/status') {
            return http.Response(
              jsonEncode({'lastSyncedAt': '2026-10-28T12:00:00.000Z'}),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode(aiStatusResponse),
            200,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      await controller.load();
      controller.serverUrl = 'http://100.64.0.8:3000';
      controller.token = 'token-token-token-token';

      await tester.pumpWidget(
        SmsAlertScope(
          controller: sms,
          child: ChangeNotifierProvider<LedgerController>.value(
            value: controller,
            child: const MaterialApp(home: SettingsScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('sms-alerts-toggle')),
        400,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Bank alerts'), findsOneWidget);
      expect(find.text('SMS bank alerts'), findsWidgets);
      expect(find.textContaining(smsBankSenderPhrase), findsWidgets);

      platform.nativeQueue.add(
        _queued('GTWorld', 'Amt:NGN2.00 DR', DateTime.utc(2026, 10, 20, 10)),
      );
      await tester.scrollUntilVisible(
        find.byKey(const Key('alert-sync-now')),
        400,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('alert-sync-now')));
      await tester.pumpAndSettle();

      expect(
        seen.where((line) => line.startsWith('POST')),
        contains('POST /api/v1/alerts/sync'),
      );
      expect(posted.map((item) => item.sender), ['GTWorld']);
      expect(find.textContaining('Sent 1 bank SMS'), findsOneWidget);
      expect(find.text('Captured 1 · Sent 1'), findsOneWidget);
      sms.dispose();
      controller.dispose();
    },
  );
}

QueuedSms _queued(String sender, String body, DateTime at) {
  return QueuedSms(
    sender: sender,
    body: body,
    receivedAt: at,
    sourceId: smsSourceId(sender: sender, body: body, receivedAt: at),
  );
}

SmsAlertController _controller(
  FakeSmsPlatform platform, {
  Future<List<bool>> Function(List<QueuedSms> batch)? upload,
}) {
  return SmsAlertController(
    store: MemorySettingsStore(),
    platform: platform,
    upload: upload ?? (batch) async => List.filled(batch.length, true),
    now: () => DateTime(2026, 10, 28, 18, 4),
  );
}

Widget _card(SmsAlertController sms) {
  return SmsAlertScope(
    controller: sms,
    child: const MaterialApp(home: Scaffold(body: SmsBankAlertsCard())),
  );
}

Future<void> _enable(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('sms-alerts-toggle')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('sms-explain-continue')));
  await tester.pumpAndSettle();
}

class FakeSmsPlatform implements SmsPlatform {
  SmsPermission permission = SmsPermission.granted;
  bool optIn = false;
  int requests = 0;
  int settingsOpens = 0;
  DateTime? importedFrom;
  DateTime? importedTo;
  final List<QueuedSms> inbox = [];
  final List<QueuedSms> nativeQueue = [];

  @override
  Future<void> ack(List<String> sourceIds) async {
    final drop = sourceIds.toSet();
    nativeQueue.removeWhere(
      (item) => item.sourceId != null && drop.contains(item.sourceId),
    );
  }

  @override
  Future<List<QueuedSms>> importInbox({
    required DateTime from,
    required DateTime to,
  }) async {
    importedFrom = from;
    importedTo = to;
    return List.of(inbox);
  }

  @override
  Future<bool> isOptedIn() async => optIn;

  @override
  void listen(void Function() onCaptured) {}

  @override
  Future<void> openAppSettings() async {
    settingsOpens += 1;
  }

  @override
  Future<List<QueuedSms>> pending() async => List.of(nativeQueue);

  @override
  Future<SmsPermission> permissionStatus() async => permission;

  @override
  Future<SmsPermission> requestPermissions() async {
    requests += 1;
    return permission;
  }

  @override
  Future<void> setOptIn(bool value) async => optIn = value;
}
