import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/ledger_controller.dart';
import 'home_shell.dart';
import 'server_screen.dart';
import 'sign_in_screen.dart';

class RootScreen extends StatelessWidget {
  const RootScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<LedgerController>();
    if (!controller.ready) {
      return const Scaffold(body: Center(child: Text('Loading…')));
    }
    if (controller.serverUrl == null) return const ServerScreen();
    if (!controller.signedIn) return const SignInScreen();
    return const HomeShell();
  }
}
