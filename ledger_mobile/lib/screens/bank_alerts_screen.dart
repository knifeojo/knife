import 'package:flutter/material.dart';

import '../alerts/senders.dart';
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
            'Email sync runs on the Ledger server. SMS bank alerts are the switch below: only $smsBankSenderPhrase are read. Personal messages are never uploaded.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          const SmsBankAlertsCard(),
          const SizedBox(height: 16),
          const AlertSyncCard(),
        ],
      ),
    );
  }
}
