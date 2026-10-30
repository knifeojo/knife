import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'alerts/push_controller.dart';
import 'alerts/push_platform.dart';
import 'alerts/sms_controller.dart';
import 'alerts/sms_platform.dart';
import 'app.dart';
import 'state/ledger_controller.dart';
import 'storage/settings_store.dart';
import 'updates/app_update.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final store = PrefsSettingsStore(prefs);
  final controller = LedgerController(store);
  final sms = SmsAlertController(store: store, platform: MethodChannelSmsPlatform(), upload: controller.uploadSmsBatch);
  final push = PushAlertController(platform: MethodChannelPushPlatform());
  final updates = AppUpdateController(platform: MethodChannelAppUpdate());
  await controller.load();
  runApp(LedgerApp(controller: controller, sms: sms, push: push, updates: updates));
}
