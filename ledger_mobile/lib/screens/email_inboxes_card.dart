import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/ledger_controller.dart';

class ConnectedInbox {
  const ConnectedInbox({required this.id, required this.provider, required this.address});

  final String id;
  final String provider;
  final String address;

  String get label {
    final kind = provider == 'gmail' ? 'Gmail' : provider == 'imap' ? 'IMAP' : provider;
    return '$kind · $address';
  }
}

/// Settings list of Gmail and IMAP/Yahoo inboxes, with Add email.
class EmailInboxesCard extends StatefulWidget {
  const EmailInboxesCard({super.key, this.openUrl});

  /// Opens the Google sign-in page. Tests pass a fake. The Android app uses the browser.
  final Future<void> Function(String url)? openUrl;

  @override
  State<EmailInboxesCard> createState() => _EmailInboxesCardState();
}

class _EmailInboxesCardState extends State<EmailInboxesCard> with WidgetsBindingObserver {
  List<ConnectedInbox> _rows = const [];
  String? _error;
  var _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    const MethodChannel('ledger/email').setMethodCallHandler((call) async {
      if (call.method == 'onConnected' && mounted) await _load();
    });
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final rows = await context.read<LedgerController>().emailConnections();
      if (!mounted) return;
      setState(() {
        _rows = [
          for (final row in rows)
            if (row['id'] is String && row['address'] is String)
              ConnectedInbox(
                id: row['id'] as String,
                provider: '${row['provider'] ?? ''}',
                address: row['address'] as String,
              ),
        ];
        _error = null;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  Future<void> _add() async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final url = await context.read<LedgerController>().startGoogleEmail();
      await (widget.openUrl ?? _openInBrowser)(url);
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('Sign in with Google is open. Return here after you allow Gmail.')),
      );
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } on MissingPluginException {
      messenger.showSnackBar(const SnackBar(content: Text('Add email runs on the Android app.')));
    } on PlatformException {
      messenger.showSnackBar(const SnackBar(content: Text('Add email runs on the Android app.')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(ConnectedInbox inbox) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await context.read<LedgerController>().removeEmailConnection(inbox.id);
      await _load();
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text('Removed ${inbox.address}.')));
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Email', style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 4),
        const Text(
          'Add email opens Sign in with Google. You can connect more than one Gmail inbox, plus Yahoo or IMAP. Ledger only reads mail. Background sync uses the same alert and statement parsers.',
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, key: const Key('email-inboxes-error')),
        ],
        for (final inbox in _rows)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(inbox.label),
            trailing: TextButton(
              key: Key('email-remove-${inbox.id}'),
              onPressed: _busy ? null : () => _remove(inbox),
              child: const Text('Remove'),
            ),
          ),
        if (_rows.isEmpty) const Text('No inboxes connected yet.'),
        const SizedBox(height: 8),
        FilledButton(
          key: const Key('add-email'),
          onPressed: _busy ? null : _add,
          child: Text(_busy ? 'Opening…' : 'Add email'),
        ),
      ],
    );
  }
}

Future<void> _openInBrowser(String url) {
  return const MethodChannel('ledger/email').invokeMethod<bool>('open', {'url': url});
}
