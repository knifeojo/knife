import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'alerts/push_controller.dart';
import 'alerts/push_sync_host.dart';
import 'alerts/sms_controller.dart';
import 'alerts/sms_sync_host.dart';
import 'screens/root_screen.dart';
import 'state/ledger_controller.dart';
import 'theme.dart';
import 'updates/app_update.dart';

class LedgerApp extends StatelessWidget {
  const LedgerApp({
    super.key,
    required this.controller,
    this.sms,
    this.push,
    this.updates,
  });

  final LedgerController controller;
  final SmsAlertController? sms;
  final PushAlertController? push;
  final AppUpdateController? updates;

  @override
  Widget build(BuildContext context) {
    return UpdateScope(
      controller: updates,
      child: SmsAlertScope(
        controller: sms,
        child: PushAlertScope(
          controller: push,
          child: ChangeNotifierProvider<LedgerController>.value(
            value: controller,
            child: Consumer<LedgerController>(
              builder: (context, controller, _) {
                return MaterialApp(
                  key: ValueKey('${controller.serverUrl}|${controller.signedIn}'),
                  title: 'Ledger',
                  theme: ledgerTheme(Brightness.light),
                  darkTheme: ledgerTheme(Brightness.dark),
                  home: const UpdateHost(
                    child: SmsSyncHost(
                      child: PushSyncHost(child: RootScreen()),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
