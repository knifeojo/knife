import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../alerts/sms_controller.dart';
import '../api/models.dart';
import '../state/ledger_controller.dart';
import '../theme.dart';
import 'affordability_screen.dart';
import 'home_screen.dart';
import 'more_screen.dart';
import 'onboarding_screen.dart';
import 'transactions_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  bool _asked = false;

  static const _titles = ['Home', 'Activity', 'Afford', 'More'];

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
    if (!mounted) return;
    try {
      await context.read<LedgerController>().overview();
    } on ApiException {
      // Badge stays at 0 until Home loads.
    }
    if (!mounted) return;
    final sms = SmsAlertScope.maybeOf(context);
    if (sms == null) return;
    try {
      await sms.onAppOpen();
    } catch (_) {
      // Captured bank SMS stay on the phone until the next sync.
    }
  }

  @override
  Widget build(BuildContext context) {
    final badge = context.watch<LedgerController>().reviewBadge;
    return Scaffold(
      appBar: AppBar(title: Text(_titles[_index])),
      body: IndexedStack(
        index: _index,
        children: const [HomeScreen(), TransactionsScreen(), AffordabilityScreen(), MoreScreen()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (index) => setState(() => _index = index),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          const NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Activity'),
          const NavigationDestination(icon: Icon(Icons.help_outline), selectedIcon: Icon(Icons.help), label: 'Afford'),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: badge > 0,
              label: Text('$badge'),
              backgroundColor: ledgerBlue,
              child: const Icon(Icons.more_horiz),
            ),
            selectedIcon: Badge(
              isLabelVisible: badge > 0,
              label: Text('$badge'),
              backgroundColor: ledgerBlue,
              child: const Icon(Icons.more_horiz),
            ),
            label: 'More',
          ),
        ],
      ),
    );
  }
}
