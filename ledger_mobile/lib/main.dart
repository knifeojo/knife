import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'state/ledger_controller.dart';
import 'storage/settings_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final controller = LedgerController(PrefsSettingsStore(prefs));
  await controller.load();
  runApp(LedgerApp(controller: controller));
}
