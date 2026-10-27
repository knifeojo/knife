import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/ledger_controller.dart';
import 'accounts_screen.dart';
import 'affordability_screen.dart';
import 'onboarding_screen.dart';
import 'settings_screen.dart';
import 'summary_screen.dart';
import 'transactions_screen.dart';
import 'upload_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  bool _asked = false;

  static const _titles = ['Home', 'Accounts', 'Activity', 'Upload', 'Afford'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeOnboard());
  }

  Future<void> _maybeOnboard() async {
    if (_asked || !mounted) return;
    _asked = true;
    try {
      final state = await context.read<LedgerController>().onboarding();
      if (!mounted || !state.needsOnboarding) return;
      await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => OnboardingScreen(initial: state)));
    } on ApiException {
      // Older servers, or a blip: the rest of the app still works.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_index]),
        actions: [
          IconButton(
            tooltip: 'Settings',
            onPressed: () {
              Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SettingsScreen()));
            },
            icon: const Icon(Icons.settings_outlined),
          ),
        ],
      ),
      body: IndexedStack(
        index: _index,
        children: const [SummaryScreen(), AccountsScreen(), TransactionsScreen(), UploadScreen(), AffordabilityScreen()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (index) => setState(() => _index = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.account_balance_outlined), selectedIcon: Icon(Icons.account_balance), label: 'Accounts'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Activity'),
          NavigationDestination(icon: Icon(Icons.upload_file_outlined), selectedIcon: Icon(Icons.upload_file), label: 'Upload'),
          NavigationDestination(icon: Icon(Icons.help_outline), selectedIcon: Icon(Icons.help), label: 'Afford'),
        ],
      ),
    );
  }
}
