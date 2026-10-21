import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../server_url.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key});

  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> {
  final _url = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await context.read<LedgerController>().connect(_url.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final cleartext = warnsAboutCleartext(_url.text.trim());
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text('Ledger', style: Theme.of(context).textTheme.headlineLarge?.copyWith(color: Theme.of(context).colorScheme.primary)),
            const SizedBox(height: 8),
            Text('Where is Ledger running?', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            const Text('This phone talks to your own server. On a laptop over Tailscale that is usually http://100.x.x.x:3000. The address stays on this phone.'),
            const SizedBox(height: 24),
            TextField(
              key: const Key('server-url'),
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(labelText: 'Server URL', hintText: 'http://100.64.0.1:3000'),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _busy ? null : _connect(),
            ),
            if (cleartext) ...[
              const SizedBox(height: 12),
              const Text('HTTP is not encrypted by itself. Use it for a Tailscale address, where the tailnet encrypts the path. Do not point this at a public network.'),
            ],
            const SizedBox(height: 16),
            ErrorText(_error),
            FilledButton(
              key: const Key('connect'),
              onPressed: _busy ? null : _connect,
              child: Text(_busy ? 'Connecting…' : 'Connect'),
            ),
          ],
        ),
      ),
    );
  }
}
