import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../server_url.dart';
import '../state/ledger_controller.dart';
import 'loans_screen.dart';
import 'people_screen.dart';
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
          Text('People', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          const Text('Statements show names, not relationships. Tell Ledger who your family and regular contacts are and their payments are labelled for good.'),
          const SizedBox(height: 8),
          OutlinedButton(key: const Key('settings-people'), onPressed: () => openPeople(context), child: const Text('Your people')),
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

  Future<void> _setRoute(String feature, String route) async {
    setState(() => _saving = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final status = await context.read<LedgerController>().setAiRoutes({feature: route});
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
    final good = theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.primary);
    final bad = theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.error);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (!status.hasRoutes) ...[
          Text('${status.providerLabel} · ${status.model.isEmpty ? 'no model' : status.model}', key: const Key('ai-provider')),
          const SizedBox(height: 2),
          Text(state, key: const Key('ai-status'), style: status.ready ? good : bad),
          const SizedBox(height: 4),
          Text(status.message, style: theme.textTheme.bodySmall),
        ] else ...[
          Text('Mode: ${status.mode ?? 'hybrid'}', key: const Key('ai-mode'), style: theme.textTheme.titleSmall),
          if (status.local case final local?) ...[
            const SizedBox(height: 8),
            Text('Local · Ollama · ${local.model.isEmpty ? 'no model' : local.model}', key: const Key('ai-local')),
            Text(
              local.reachable && local.modelInstalled != false ? 'Reachable' : local.reachable ? 'Model not installed' : 'Not reachable',
              key: const Key('ai-local-status'),
              style: local.reachable && local.modelInstalled != false ? good : bad,
            ),
            Text(local.message, style: theme.textTheme.bodySmall),
          ],
          if (status.cloudProvider case final cloud?) ...[
            const SizedBox(height: 8),
            Text('Cloud · Anthropic · ${cloud.model}', key: const Key('ai-cloud')),
            Text(
              cloud.keySet == true ? (cloud.reachable ? 'Reachable' : 'Not reachable') : 'Not configured',
              key: const Key('ai-cloud-status'),
              style: cloud.keySet == true && cloud.reachable ? good : bad,
            ),
            Text('ANTHROPIC_API_KEY: ${cloud.keySet == true ? 'set' : 'not set'}', key: const Key('ai-cloud-key'), style: theme.textTheme.bodySmall),
            if (cloud.message.isNotEmpty) Text(cloud.message, style: theme.textTheme.bodySmall),
          ],
          for (final note in status.notes)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(note, key: const Key('ai-note'), style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
            ),
          const SizedBox(height: 8),
          for (final route in status.routes.values) _routeRow(theme, route),
          Text('Cloud calls get names, account and phone numbers removed and amounts rounded first.', style: theme.textTheme.bodySmall),
        ],
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

  Widget _routeRow(ThemeData theme, AiRouteStatus route) {
    final labels = AiRouteStatus.routeLabels;
    final runs = route.route == route.requested ? null : 'Runs: ${labels[route.route] ?? route.route}';
    final detail = [?runs, ?route.note].join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(route.label),
                if (detail.isNotEmpty) Text(detail, key: Key('ai-route-note-${route.feature}'), style: theme.textTheme.bodySmall),
              ],
            ),
          ),
          DropdownButton<String>(
            key: Key('ai-route-${route.feature}'),
            value: route.userSet ? route.requested : 'default',
            onChanged: _saving ? null : (value) => value == null ? null : _setRoute(route.feature, value),
            items: [
              DropdownMenuItem(value: 'default', child: Text('Default (${labels[route.serverDefault] ?? route.serverDefault})')),
              for (final entry in labels.entries) DropdownMenuItem(value: entry.key, child: Text(entry.value)),
            ],
          ),
        ],
      ),
    );
  }
}
