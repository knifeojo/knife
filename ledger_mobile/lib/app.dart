import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/root_screen.dart';
import 'state/ledger_controller.dart';
import 'theme.dart';

class LedgerApp extends StatelessWidget {
  const LedgerApp({super.key, required this.controller});

  final LedgerController controller;

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<LedgerController>.value(
      value: controller,
      child: Consumer<LedgerController>(
        builder: (context, controller, _) {
          return MaterialApp(
            key: ValueKey('${controller.serverUrl}|${controller.signedIn}'),
            title: 'Ledger',
            theme: ledgerTheme(Brightness.light),
            darkTheme: ledgerTheme(Brightness.dark),
            home: const RootScreen(),
          );
        },
      ),
    );
  }
}
