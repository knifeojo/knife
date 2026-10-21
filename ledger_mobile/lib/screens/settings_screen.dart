import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../server_url.dart';
import '../state/ledger_controller.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<LedgerController>();
    final url = controller.serverUrl ?? '';
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(controller.user?.email ?? 'Signed in', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 16),
          Text('Server', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          Text(url),
          if (warnsAboutCleartext(url)) ...[
            const SizedBox(height: 8),
            const Text('This URL is HTTP. That is expected for a Tailscale address. Do not use it off a private network.'),
          ],
          const SizedBox(height: 24),
          OutlinedButton(onPressed: controller.signOut, child: const Text('Sign out')),
          const SizedBox(height: 8),
          TextButton(onPressed: controller.forgetServer, child: const Text('Use a different server')),
          const SizedBox(height: 24),
          Text(
            'The session token is kept in this app’s private storage. Signing out revokes it on the server.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
