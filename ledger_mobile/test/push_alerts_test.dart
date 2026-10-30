import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/alerts/push_controller.dart';
import 'package:ledger_mobile/alerts/push_platform.dart';
import 'package:ledger_mobile/alerts/push_sync_host.dart';
import 'package:ledger_mobile/alerts/source_id.dart';
import 'package:ledger_mobile/screens/push_alerts_card.dart';

void main() {
  test('push source id matches the Android hash', () {
    expect(
      pushSourceId(
        packageName: 'com.example.gtbank',
        postedAt: DateTime.fromMillisecondsSinceEpoch(1728314220000, isUtc: true),
        text: 'Amt:NGN1.00 DR',
      ),
      'b5fed7a40751a36100ca7eeb5d7e2421b7c44bf99d418e6c8fd6715d5e3f4e42',
    );
  });

  testWidgets('a new financial app asks once', (tester) async {
    final platform = _FakePush();
    platform.pending.add(
      const PendingPushApp(packageName: 'com.example.gtbank', label: 'GTBank'),
    );
    final push = PushAlertController(platform: platform);
    await tester.pumpWidget(
      PushAlertScope(
        controller: push,
        child: const MaterialApp(home: PushSyncHost(child: SizedBox.shrink())),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Track alerts from GTBank?'), findsOneWidget);

    await tester.tap(find.byKey(const Key('push-track-yes')));
    await tester.pumpAndSettle();
    expect(platform.approved, ['com.example.gtbank']);
    expect(find.text('Track alerts from GTBank?'), findsNothing);
    push.dispose();
  });

  testWidgets('the card explains notification access when the plugin is missing', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PushAlertsCard())));
    await tester.pumpAndSettle();
    expect(find.text('Allow notification access'), findsOneWidget);
    await tester.tap(find.byKey(const Key('push-open-settings')));
    await tester.pumpAndSettle();
    expect(find.text('App alerts run on the Android app.'), findsOneWidget);
  });

  testWidgets('allow notification access opens the system screen', (tester) async {
    final platform = _FakePush();
    final push = PushAlertController(platform: platform);
    await tester.pumpWidget(
      PushAlertScope(
        controller: push,
        child: const MaterialApp(home: Scaffold(body: PushAlertsCard())),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('push-open-settings')));
    await tester.pumpAndSettle();
    expect(platform.opened, isTrue);
    push.dispose();
  });
}

class _FakePush implements PushPlatform {
  bool access = false;
  bool opened = false;
  final pending = <PendingPushApp>[];
  final approved = <String>[];
  final denied = <String>[];

  @override
  Future<void> approve(String packageName) async {
    approved.add(packageName);
    pending.removeWhere((app) => app.packageName == packageName);
  }

  @override
  Future<void> deny(String packageName) async {
    denied.add(packageName);
    pending.removeWhere((app) => app.packageName == packageName);
  }

  @override
  Future<bool> enabled() async => access;

  @override
  void listen(void Function() onQueued) {}

  @override
  Future<void> openSettings() async {
    opened = true;
  }

  @override
  Future<List<PendingPushApp>> pendingApps() async => List.of(pending);
}
