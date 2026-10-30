import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ledger_mobile/updates/app_update.dart';

void main() {
  test('only a higher build number is an update', () {
    expect(isNewerBuild(5, 6), isTrue);
    expect(isNewerBuild(6, 6), isFalse);
    expect(isNewerBuild(7, 6), isFalse);
  });

  test('refresh records a downloaded update and ignores an older one', () async {
    final platform = _Fake();
    final controller = AppUpdateController(platform: platform);
    platform.offer = const UpdateOffer(ready: true, version: '0.3.4', buildNumber: 9);
    await controller.refresh();
    expect(controller.ready, isTrue);
    expect(controller.version, '0.3.4');
    expect(platform.daily, 1);

    platform.offer = const UpdateOffer(ready: false);
    await controller.refresh();
    expect(controller.ready, isFalse);
    controller.dispose();
  });

  testWidgets('Update ready launches the installer', (tester) async {
    final platform = _Fake()
      ..offer = const UpdateOffer(ready: true, version: '0.3.4', buildNumber: 9);
    final controller = AppUpdateController(platform: platform);
    await tester.pumpWidget(
      UpdateScope(
        controller: controller,
        child: const MaterialApp(home: UpdateHost(child: Scaffold(body: Text('Home')))),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Update ready'), findsOneWidget);
    expect(find.text('Home'), findsOneWidget);

    await tester.tap(find.byKey(const Key('update-ready')));
    await tester.pumpAndSettle();
    expect(platform.installs, 1);
    controller.dispose();
  });

  testWidgets('no banner when nothing newer has been downloaded', (tester) async {
    final controller = AppUpdateController(platform: _Fake());
    await tester.pumpWidget(
      UpdateScope(
        controller: controller,
        child: const MaterialApp(home: UpdateHost(child: Scaffold(body: Text('Home')))),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Update ready'), findsNothing);
    expect(find.text('Home'), findsOneWidget);
    controller.dispose();
  });
}

class _Fake implements AppUpdatePlatform {
  UpdateOffer? offer;
  int installs = 0;
  int daily = 0;

  @override
  Future<UpdateOffer?> check() async => offer;

  @override
  Future<void> ensureDaily() async {
    daily += 1;
  }

  @override
  Future<void> install() async {
    installs += 1;
  }

  @override
  Future<UpdateOffer?> ready() async => offer;
}
