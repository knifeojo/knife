import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

/// After the first upload: one-tap who the people you send the most money to are.
class TopPeopleScreen extends StatefulWidget {
  const TopPeopleScreen({super.key, required this.initial});

  final OnboardingState initial;

  @override
  State<TopPeopleScreen> createState() => _TopPeopleScreenState();
}

class _TopPeopleScreenState extends State<TopPeopleScreen> {
  late OnboardingState _state;
  bool _busy = false;
  String? _error;

  static const _picks = [
    ('rel:spouse', 'Spouse / partner'),
    ('rel:sibling', 'Sibling'),
    ('rel:parent', 'Parent'),
    ('rel:child', 'Child'),
    ('rel:extended', 'Extended family'),
    ('rel:friend', 'Friend'),
  ];

  @override
  void initState() {
    super.initState();
    _state = widget.initial;
  }

  Future<void> _answer(TopPerson p, PeopleGuessAnswer a) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final controller = context.read<LedgerController>();
      await controller.answerReview(
        kind: 'person',
        key: p.key,
        value: a.value,
        vendorCategory: a.vendorCategory,
        vendorSubcategory: a.vendorSubcategory,
      );
      if (!mounted) return;
      final next = await controller.onboarding();
      if (!mounted) return;
      setState(() {
        _state = next;
        _error = null;
      });
      if (!next.showTopPeople && mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _done() async {
    setState(() => _busy = true);
    try {
      await context.read<LedgerController>().finishTopPeople();
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Who are they?'),
        actions: [TextButton(key: const Key('top-people-done'), onPressed: _busy ? null : _done, child: const Text('Done'))],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('You send money to these people most. Who are they?', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('One tap each. Your answer labels every payment with them, past and future.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 8),
          ErrorText(_error),
          for (final p in _state.topPeople)
            Card(
              key: Key('top-person-${p.key}'),
              margin: const EdgeInsets.only(bottom: 12),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.display, style: theme.textTheme.titleMedium),
                    Text(
                      'Sent ${formatMinor(p.person.outMinor)} in ${p.person.outCount}',
                      style: theme.textTheme.bodySmall,
                    ),
                    if (p.guess != null) ...[
                      const SizedBox(height: 6),
                      Text(p.guess!.reason, key: Key('guess-${p.key}'), style: theme.textTheme.labelSmall),
                    ],
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final a in p.guess?.answers ?? [for (final x in _picks) PeopleGuessAnswer(value: x.$1, label: x.$2)])
                          OutlinedButton(
                            key: Key('top-${p.key}-${a.label}'),
                            onPressed: _busy ? null : () => _answer(p, a),
                            child: Text(a.label),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          Text(_state.trustNote, style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}
