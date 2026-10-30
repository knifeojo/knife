import 'package:flutter/material.dart';

import '../alerts/senders.dart';
import 'push_alerts_card.dart';
import 'settings_screen.dart';
import 'sms_alerts_card.dart';

class BankAlertsScreen extends StatelessWidget {
  const BankAlertsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Bank alerts')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Email sync runs on the Ledger server. SMS alerts read account texts on this phone. App alerts read bank notifications after you allow notification access. $smsBankSenderPhrase are tracked automatically. A new sender or app asks once. Personal chats, OTPs and promos are never uploaded.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          const SmsBankAlertsCard(),
          const SizedBox(height: 16),
          const PushAlertsCard(),
          const SizedBox(height: 16),
          const AlertSyncCard(),
        ],
      ),
    );
  }
}
