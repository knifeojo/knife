import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
import 'push_alerts_card.dart';

/// One short skippable form: who the owner is and who their people are.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, this.initial});

  final OnboardingState? initial;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  OnboardingState? _state;
  String? _error;
  bool _busy = false;
  final _ownName = TextEditingController();
  final _partner = TextEditingController();
  final _parents = TextEditingController();
  final _siblings = TextEditingController();
  final _supported = TextEditingController();
  String? _status;

  @override
  void initState() {
    super.initState();
    _state = widget.initial;
    _ownName.text = widget.initial?.ownName ?? '';
    _status = widget.initial?.relationshipStatus;
    if (widget.initial == null) _load();
  }

  @override
  void dispose() {
    _ownName.dispose();
    _partner.dispose();
    _parents.dispose();
    _siblings.dispose();
    _supported.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final state = await context.read<LedgerController>().onboarding();
      if (!mounted) return;
      setState(() {
        _state = state;
        _ownName.text = state.ownName ?? '';
        _status = state.relationshipStatus;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _save({required bool skip}) async {
    setState(() => _busy = true);
    try {
      await context.read<LedgerController>().saveOnboarding(
        skip: skip,
        ownName: _ownName.text.trim().isEmpty ? null : _ownName.text.trim(),
        relationshipStatus: _status,
        partner: _partner.text.trim().isEmpty ? null : _partner.text.trim(),
        parents: _parents.text.trim().isEmpty ? null : _parents.text.trim(),
        siblings: _siblings.text.trim().isEmpty ? null : _siblings.text.trim(),
        supported: _supported.text.trim().isEmpty ? null : _supported.text.trim(),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    final askName = state == null || state.ownName == null || state.ownName!.isEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('Who are your people?')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('A few names so Ledger can label their payments from the first statement. Skip any you would rather not say.'),
          const SizedBox(height: 16),
          ErrorText(_error),
          if (askName) ...[
            TextField(key: const Key('onboard-name'), controller: _ownName, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Your full name')),
            const SizedBox(height: 12),
          ],
          Text('Relationship status', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final s in state?.statuses ?? const [])
                ChoiceChip(
                  key: Key('status-${s.value}'),
                  label: Text(s.label),
                  selected: _status == s.value,
                  onSelected: _busy ? null : (_) => setState(() => _status = s.value),
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('onboard-partner'),
            controller: _partner,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Partner (spouse, fiancé(e), girlfriend/boyfriend)'),
          ),
          const SizedBox(height: 12),
          TextField(key: const Key('onboard-parents'), controller: _parents, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Parents', hintText: 'Comma-separated names')),
          const SizedBox(height: 12),
          TextField(key: const Key('onboard-siblings'), controller: _siblings, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Siblings', hintText: 'Comma-separated names')),
          const SizedBox(height: 12),
          TextField(
            key: const Key('onboard-supported'),
            controller: _supported,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Anyone you support regularly', hintText: 'Labelled Family / Black tax'),
          ),
          const SizedBox(height: 16),
          const PushAlertsCard(),
          const SizedBox(height: 16),
          Text(state?.trustNote ?? 'These names stay on your device and are never sent to the cloud.', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          FilledButton(key: const Key('onboard-save'), onPressed: _busy ? null : () => _save(skip: false), child: Text(_busy ? 'Saving…' : 'Save')),
          TextButton(key: const Key('onboard-skip'), onPressed: _busy ? null : () => _save(skip: true), child: const Text('Skip for now')),
        ],
      ),
    );
  }
}
