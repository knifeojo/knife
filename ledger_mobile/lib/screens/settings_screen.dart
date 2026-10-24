import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../server_url.dart';
import '../state/ledger_controller.dart';
import 'loans_screen.dart';
import 'review_screen.dart';

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
          Text('Categories', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          const Text('Re-run applies the latest rules to every transaction. Labels you chose, and Review answers, are kept.'),
          const SizedBox(height: 8),
          const RerunCategorizationButton(),
          const SizedBox(height: 8),
          OutlinedButton(
            key: const Key('settings-review'),
            onPressed: () => openReview(context),
            child: const Text('Review payments that need a purpose'),
          ),
          const SizedBox(height: 24),
          Text('AI categorization', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          const AiSettingsCard(),
          const SizedBox(height: 24),
          Text('Loans', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          const Text('Statements show repayments, not what is left. Enter the balance from your loan app so Afford can use it.'),
          const SizedBox(height: 8),
          OutlinedButton(key: const Key('settings-loans'), onPressed: () => openLoans(context), child: const Text('Your loans')),
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

/// "Re-run categorization": the same server logic as the web Settings button.
class RerunCategorizationButton extends StatefulWidget {
  const RerunCategorizationButton({super.key});

  @override
  State<RerunCategorizationButton> createState() => _RerunCategorizationButtonState();
}

class _RerunCategorizationButtonState extends State<RerunCategorizationButton> {
  bool _running = false;

  Future<void> _run() async {
    setState(() => _running = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await context.read<LedgerController>().rerunCategorization();
      messenger.showSnackBar(SnackBar(content: Text(result.message)));
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _running = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      key: const Key('rerun-categorization'),
      onPressed: _running ? null : _run,
      child: Text(_running ? 'Re-running…' : 'Re-run categorization'),
    );
  }
}

/// AI status (provider, model, reachable) and the on/off toggle, the same as the web Settings card.
class AiSettingsCard extends StatefulWidget {
  const AiSettingsCard({super.key});

  @override
  State<AiSettingsCard> createState() => _AiSettingsCardState();
}

class _AiSettingsCardState extends State<AiSettingsCard> {
  AiStatus? _status;
  String? _error;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final status = await context.read<LedgerController>().aiStatus();
      if (!mounted) return;
      setState(() {
        _status = status;
        _error = null;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  Future<void> _toggle(bool enabled) async {
    setState(() => _saving = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final status = await context.read<LedgerController>().setAiEnabled(enabled);
      if (mounted) setState(() => _status = status);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = _status;
    if (status == null) {
      return Text(_error == null ? 'Checking AI…' : 'AI status unavailable: $_error', key: const Key('ai-status'));
    }
    final state = status.ready ? 'Reachable' : status.reachable ? 'Model not installed' : 'Not reachable';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('${status.providerLabel} · ${status.model.isEmpty ? 'no model' : status.model}', key: const Key('ai-provider')),
        const SizedBox(height: 2),
        Text(state, key: const Key('ai-status'), style: theme.textTheme.bodyMedium?.copyWith(color: status.ready ? theme.colorScheme.primary : theme.colorScheme.error)),
        const SizedBox(height: 4),
        Text(status.message, style: theme.textTheme.bodySmall),
        SwitchListTile(
          key: const Key('ai-toggle'),
          contentPadding: EdgeInsets.zero,
          title: const Text('Suggest categories with AI'),
          subtitle: Text(
            status.enabled
                ? '${status.pendingSuggestions} suggestion${status.pendingSuggestions == 1 ? '' : 's'} waiting in Review · ${status.backlog} not looked at yet'
                : 'Only payments the rules cannot label. You confirm each one in Review.',
          ),
          value: status.enabled,
          onChanged: _saving || (!status.enabled && !status.available) ? null : _toggle,
        ),
      ],
    );
  }
}
