import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/ledger_controller.dart';
import '../theme.dart';
import 'accounts_screen.dart';
import 'bank_alerts_screen.dart';
import 'insights_screen.dart';
import 'loans_screen.dart';
import 'people_screen.dart';
import 'review_screen.dart';
import 'settings_screen.dart';
import 'upload_screen.dart';

class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final badge = context.watch<LedgerController>().reviewBadge;
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        _row(
          context,
          key: 'more-review',
          icon: Icons.flag_outlined,
          title: 'Review',
          badge: badge,
          onTap: () => openReview(context),
        ),
        _row(context, key: 'more-insights', icon: Icons.insights_outlined, title: 'Insights', onTap: () => openInsights(context)),
        _row(context, key: 'more-people', icon: Icons.people_outline, title: 'People', onTap: () => openPeople(context)),
        _row(context, key: 'more-loans', icon: Icons.account_balance_outlined, title: 'Loans', onTap: () => openLoans(context)),
        _row(
          context,
          key: 'more-accounts',
          icon: Icons.wallet_outlined,
          title: 'Accounts and balances',
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => Scaffold(appBar: AppBar(title: const Text('Accounts')), body: const AccountsScreen()))),
        ),
        _row(
          context,
          key: 'more-upload',
          icon: Icons.upload_file_outlined,
          title: 'Upload statement',
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => Scaffold(appBar: AppBar(title: const Text('Upload')), body: const UploadScreen()))),
        ),
        _row(
          context,
          key: 'more-alerts',
          icon: Icons.sms_outlined,
          title: 'Bank alerts',
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const BankAlertsScreen())),
        ),
        _row(
          context,
          key: 'more-settings',
          icon: Icons.settings_outlined,
          title: 'Settings',
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SettingsScreen())),
        ),
      ],
    );
  }

  Widget _row(BuildContext context, {required String key, required IconData icon, required String title, required VoidCallback onTap, int badge = 0}) {
    return ListTile(
      key: Key(key),
      leading: Icon(icon),
      title: Text(title),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (badge > 0)
            Badge(label: Text('$badge'), backgroundColor: ledgerBlue),
          const Icon(Icons.chevron_right),
        ],
      ),
      onTap: onTap,
    );
  }
}
