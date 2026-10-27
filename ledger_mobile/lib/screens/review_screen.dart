import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
import 'people_screen.dart';

/// Opens Review. Resolves to true when at least one answer was saved, so the caller can reload its figures.
Future<bool> openReview(BuildContext context) async {
  final changed = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const ReviewScreen()));
  return changed == true;
}

/// "Help Ledger get this right": the same questions as the web Review page.
class ReviewScreen extends StatefulWidget {
  const ReviewScreen({super.key});

  @override
  State<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends State<ReviewScreen> {
  ReviewQueue? _queue;
  String? _error;
  bool _busy = false;
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final queue = await context.read<LedgerController>().review();
      if (!mounted) return;
      setState(() {
        _queue = queue;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _answer(ReviewQuestion q, String value, {String? otherText, String? otherCategory, String? vendorCategory, String? vendorSubcategory}) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final updated = await context.read<LedgerController>().answerReview(
        kind: q.kind,
        key: q.key,
        value: value,
        otherText: otherText,
        otherCategory: otherCategory,
        vendorCategory: vendorCategory,
        vendorSubcategory: vendorSubcategory,
      );
      _changed = true;
      final relabelled = '$updated payment${updated == 1 ? '' : 's'} relabelled.';
      final message = switch (value) {
        'unknown' => 'Ledger will not ask about this again.',
        'not_person' => 'Ledger will not ask about this name as a person again.',
        _ when value.startsWith('rel:') => 'Saved to Your people. $relabelled You can change it or undo it there.',
        _ => 'Saved. $relabelled',
      };
      messenger.showSnackBar(SnackBar(content: Text(message)));
      await _load();
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _suggestion(AiSuggestion s, String action) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final updated = await context.read<LedgerController>().answerSuggestion(id: s.id, action: action);
      if (action == 'confirm') _changed = true;
      messenger.showSnackBar(
        SnackBar(content: Text(action == 'confirm' ? 'Saved as ${s.label}. $updated payment${updated == 1 ? '' : 's'} relabelled.' : 'Suggestion dismissed.')),
      );
      await _load();
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _other(ReviewQuestion q, List<String> categories) async {
    final result = await showDialog<({String text, String? category})>(
      context: context,
      builder: (_) => _OtherDialog(question: q, categories: categories),
    );
    if (result == null) return;
    await _answer(q, 'other', otherText: result.text, otherCategory: result.category);
  }

  Future<void> _vendor(ReviewQuestion q, List<String> categories) async {
    final result = await showDialog<({String category, String? what})>(
      context: context,
      builder: (_) => VendorDialog(categories: categories),
    );
    if (result == null) return;
    await _answer(q, 'rel:vendor', vendorCategory: result.category, vendorSubcategory: result.what);
  }

  Future<void> _openPeople() async {
    final changed = await openPeople(context);
    if (changed) {
      _changed = true;
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final queue = _queue;
    return PopScope<bool>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Review'),
          actions: [IconButton(key: const Key('review-people'), tooltip: 'Your people', icon: const Icon(Icons.people_outline), onPressed: _openPeople)],
        ),
        body: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            key: const Key('review-list'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              Text(
                'Your bank often records who was paid, not what for. Each answer labels every payment with that name, now and in future statements.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              if (_error != null) ErrorText(_error),
              if (queue == null && _error == null) const Text('Loading…'),
              if (queue != null && queue.questions.isEmpty && queue.suggestions.isEmpty) const EmptyNote('Nothing to review. Ledger has labelled everything it can.'),
              if (queue != null)
                for (final (i, q) in queue.questions.indexed)
                  ReviewQuestionCard(
                    key: Key('question-${q.kind}-${q.key}'),
                    question: q,
                    index: i,
                    total: queue.questions.length,
                    busy: _busy,
                    onAnswer: (value, {otherText, otherCategory, vendorCategory, vendorSubcategory}) =>
                        _answer(q, value, otherText: otherText, otherCategory: otherCategory, vendorCategory: vendorCategory, vendorSubcategory: vendorSubcategory),
                    onOther: () => _other(q, queue.categories),
                    onVendor: () => _vendor(q, queue.categories),
                    onSuggestion: _suggestion,
                  ),
              if (queue != null && queue.suggestions.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Suggested by AI', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(
                  'Payments the rules could not label. Nothing changes until you confirm; confirming also labels future payments to the same payee.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 8),
                for (final s in queue.suggestions) AiSuggestionCard(key: Key('suggestion-${s.id}'), suggestion: s, busy: _busy, onAnswer: _suggestion),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

typedef ReviewAnswer = void Function(String value, {String? otherText, String? otherCategory, String? vendorCategory, String? vendorSubcategory});

/// `action` is "confirm" or "dismiss".
typedef SuggestionAnswer = void Function(AiSuggestion suggestion, String action);

/// The AI's pick, pre-selected: one tap confirms it and saves it as a rule for this payee.
class AiPick extends StatelessWidget {
  const AiPick({super.key, required this.suggestion, required this.busy, required this.onAnswer});

  final AiSuggestion suggestion;
  final bool busy;
  final SuggestionAnswer onAnswer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = suggestion;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: theme.colorScheme.primaryContainer.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: theme.colorScheme.primary.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Suggested by AI (${s.model}) · ${(s.confidence * 100).round()}% sure', style: theme.textTheme.labelSmall),
          const SizedBox(height: 2),
          Text(s.reason.isEmpty ? s.label : '${s.label} · ${s.reason}', style: theme.textTheme.bodyMedium),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            children: [
              FilledButton(key: Key('confirm-${s.id}'), onPressed: busy ? null : () => onAnswer(s, 'confirm'), child: Text('Confirm ${s.label}')),
              TextButton(key: Key('dismiss-${s.id}'), onPressed: busy ? null : () => onAnswer(s, 'dismiss'), child: const Text('Not right')),
            ],
          ),
        ],
      ),
    );
  }
}

/// An AI suggestion for a payee no Review question covers.
class AiSuggestionCard extends StatelessWidget {
  const AiSuggestionCard({super.key, required this.suggestion, required this.busy, required this.onAnswer});

  final AiSuggestion suggestion;
  final bool busy;
  final SuggestionAnswer onAnswer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = suggestion;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.display, style: theme.textTheme.titleMedium),
            const SizedBox(height: 2),
            Text(
              '${formatMinor(s.totalMinor)} · ${s.count} payment${s.count == 1 ? '' : 's'} ${s.direction == 'in' ? 'in' : 'out'} · now "${s.currentCategory}"',
              style: theme.textTheme.bodySmall,
            ),
            for (final e in s.examples)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(top: 4),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(6)),
                child: SelectableText(e, style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
              ),
            AiPick(suggestion: s, busy: busy, onAnswer: onAnswer),
          ],
        ),
      ),
    );
  }
}

class ReviewQuestionCard extends StatelessWidget {
  const ReviewQuestionCard({
    super.key,
    required this.question,
    required this.index,
    required this.total,
    required this.busy,
    required this.onAnswer,
    required this.onOther,
    this.onVendor,
    this.onSuggestion,
  });

  final ReviewQuestion question;
  final int index;
  final int total;
  final bool busy;
  final ReviewAnswer onAnswer;
  final VoidCallback onOther;

  /// "Vendor / service provider": asks what they are paid for, then answers rel:vendor.
  final VoidCallback? onVendor;
  final SuggestionAnswer? onSuggestion;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final q = question;
    final examples = q.examples;
    if (q.isPerson) {
      return Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: PersonQuestionBody(question: q, index: index, total: total, busy: busy, onAnswer: onAnswer, onOther: onOther, onVendor: onVendor),
        ),
      );
    }
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Question ${index + 1} of $total', style: theme.textTheme.labelSmall),
            const SizedBox(height: 4),
            Text(q.title, style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(q.prompt, style: theme.textTheme.bodyMedium),
            if (q.totalMinor != '0') ...[
              const SizedBox(height: 6),
              Text(
                '${formatMinor(q.totalMinor, currency: q.totalCurrency ?? 'NGN')}${q.totalDetail == null || q.totalDetail!.isEmpty ? '' : ' (${q.totalDetail})'} · ${q.count} payment${q.count == 1 ? '' : 's'}${q.currentCategory == null ? '' : ' · now "${q.currentCategory}"'}',
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (q.hint != null) ...[const SizedBox(height: 6), Chip(label: Text(q.hint!), visualDensity: VisualDensity.compact)],
            if (q.narrationHints.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('From the narration:', style: theme.textTheme.bodySmall),
                  for (final h in q.narrationHints)
                    ActionChip(
                      key: Key('hint-${h.words}'),
                      tooltip: 'Use this as the answer',
                      label: Text('"${h.words.toUpperCase()}"${h.category == 'Other' ? '' : ' → ${h.category}'}'),
                      onPressed: busy ? null : () => onAnswer('other', otherText: h.words, otherCategory: h.category == 'Other' ? null : h.category),
                    ),
                ],
              ),
            ],
            if (examples.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(examples.length == 1 ? 'What your bank wrote' : 'What your bank wrote (${examples.length} of ${q.count})', style: theme.textTheme.bodySmall),
              const SizedBox(height: 4),
              for (final e in examples)
                Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(bottom: 4),
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(6)),
                  child: SelectableText(e, style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
                ),
            ],
            if (q.aiSuggestion != null && onSuggestion != null) AiPick(suggestion: q.aiSuggestion!, busy: busy, onAnswer: onSuggestion!),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (k, o) in q.options.indexed)
                  k == 0 && o.value == 'hint' && q.aiSuggestion == null
                      ? FilledButton(onPressed: busy ? null : () => onAnswer(o.value), child: Text(o.label))
                      : OutlinedButton(onPressed: busy ? null : () => onAnswer(o.value), child: Text(o.label)),
              ],
            ),
            if (q.allowsOther)
              Wrap(
                spacing: 8,
                children: [
                  TextButton(onPressed: busy ? null : () => onAnswer('unknown'), child: const Text('Can’t remember')),
                  TextButton(key: Key('other-${q.key}'), onPressed: busy ? null : onOther, child: const Text('Other… type your own answer')),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// "Paid out ₦50,000 in 4 · Received ₦10,000 in 1 · last 2026-09-30".
class PersonStatsLine extends StatelessWidget {
  const PersonStatsLine({super.key, required this.stats});

  final PersonStats stats;

  @override
  Widget build(BuildContext context) {
    final s = stats;
    final parts = [
      if (s.outCount > 0) 'Paid out ${formatMinor(s.outMinor)} in ${s.outCount}',
      if (s.inCount > 0) 'Received ${formatMinor(s.inMinor)} in ${s.inCount}',
      if (s.lastDate.isNotEmpty) 'last ${s.lastDate}',
    ];
    return Text(parts.join(' · '), style: Theme.of(context).textTheme.bodySmall);
  }
}

/// "Who is NAME to you?": one tap per relationship, the AI's guess highlighted, the rarer answers
/// behind "Someone else…", and Skip / Not a person.
class PersonQuestionBody extends StatefulWidget {
  const PersonQuestionBody({
    super.key,
    required this.question,
    required this.index,
    required this.total,
    required this.busy,
    required this.onAnswer,
    required this.onOther,
    this.onVendor,
  });

  final ReviewQuestion question;
  final int index;
  final int total;
  final bool busy;
  final ReviewAnswer onAnswer;
  final VoidCallback onOther;
  final VoidCallback? onVendor;

  @override
  State<PersonQuestionBody> createState() => _PersonQuestionBodyState();
}

class _PersonQuestionBodyState extends State<PersonQuestionBody> {
  bool _more = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final q = widget.question;
    final busy = widget.busy;
    final stats = q.person!;
    final relationships = q.options.where((o) => o.group == 'relationship' && o.value != 'rel:other').toList();
    final other = q.options.where((o) => o.value == 'rel:other');
    final more = q.options.where((o) => o.group == 'more');
    final control = q.options.where((o) => o.group == 'control');
    final aiPick = q.aiRelationship == null ? null : 'rel:${q.aiRelationship}';
    final aiOption = relationships.where((o) => o.value == aiPick).firstOrNull;

    void tap(ReviewOption o) {
      if (o.value == 'rel:vendor' && widget.onVendor != null) {
        widget.onVendor!();
      } else {
        widget.onAnswer(o.value);
      }
    }

    Widget button(ReviewOption o) {
      final key = Key('rel-${o.value.substring(4)}');
      final label = Text(o.label);
      if (o.value == aiPick) return FilledButton(key: key, onPressed: busy ? null : () => tap(o), child: label);
      return OutlinedButton(key: key, onPressed: busy ? null : () => tap(o), child: label);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Question ${widget.index + 1} of ${widget.total} · about a person', style: theme.textTheme.labelSmall),
        const SizedBox(height: 4),
        Text(q.title, style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(q.prompt, style: theme.textTheme.bodyMedium),
        const SizedBox(height: 6),
        PersonStatsLine(key: Key('person-stats-${q.key}'), stats: stats),
        if (stats.variants.length > 1) ...[
          const SizedBox(height: 4),
          Text('Also written as: ${stats.variants.skip(1).join(', ')}', style: theme.textTheme.bodySmall),
        ],
        if (q.examples.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('What your bank wrote', style: theme.textTheme.bodySmall),
          const SizedBox(height: 4),
          for (final e in q.examples)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(6)),
              child: SelectableText(e, style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
            ),
        ],
        if (q.guess != null) ...[
          const SizedBox(height: 8),
          Text(q.guess!.reason, key: Key('people-guess-${q.key}'), style: theme.textTheme.labelSmall),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final a in q.guess!.answers)
                FilledButton(
                  key: Key('guess-${q.key}-${a.label}'),
                  onPressed: busy ? null : () => widget.onAnswer(a.value, vendorCategory: a.vendorCategory, vendorSubcategory: a.vendorSubcategory),
                  child: Text(a.label),
                ),
            ],
          ),
        ],
        if (aiOption != null) ...[
          const SizedBox(height: 6),
          Text('AI thinks: ${aiOption.label}. Tap it to confirm.', key: Key('ai-relationship-${q.key}'), style: theme.textTheme.labelSmall),
        ],
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [for (final o in relationships) button(o)]),
        const SizedBox(height: 4),
        if (!_more)
          TextButton(key: Key('someone-else-${q.key}'), onPressed: busy ? null : () => setState(() => _more = true), child: const Text('Someone else…'))
        else ...[
          const SizedBox(height: 6),
          Text('Someone else', style: theme.textTheme.labelLarge),
          const SizedBox(height: 4),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final o in other) button(o),
              for (final o in more) OutlinedButton(onPressed: busy ? null : () => widget.onAnswer(o.value), child: Text(o.label)),
              TextButton(key: Key('other-${q.key}'), onPressed: busy ? null : widget.onOther, child: const Text('Other… type your own answer')),
            ],
          ),
        ],
        Wrap(
          spacing: 8,
          children: [
            for (final o in control)
              TextButton(
                key: Key('${o.value == 'not_person' ? 'not-person' : 'skip'}-${q.key}'),
                onPressed: busy ? null : () => widget.onAnswer(o.value),
                child: Text(o.label),
              ),
          ],
        ),
      ],
    );
  }
}

/// "What do you pay them for?" for a vendor: a category, and optionally the service.
class VendorDialog extends StatefulWidget {
  const VendorDialog({super.key, required this.categories});

  final List<String> categories;

  @override
  State<VendorDialog> createState() => _VendorDialogState();
}

class _VendorDialogState extends State<VendorDialog> {
  final _what = TextEditingController();
  String? _category;

  @override
  void dispose() {
    _what.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('What do you pay them for?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DropdownButtonFormField<String>(
            key: const Key('vendor-category'),
            initialValue: _category,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Category'),
            items: [for (final c in widget.categories) DropdownMenuItem<String>(value: c, child: Text(c))],
            onChanged: (value) => setState(() => _category = value),
          ),
          TextField(
            key: const Key('vendor-what'),
            controller: _what,
            maxLength: 40,
            decoration: const InputDecoration(labelText: 'What for (optional)', hintText: 'e.g. tailor, driver, hair'),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          key: const Key('vendor-save'),
          onPressed: _category == null
              ? null
              : () {
                  final what = _what.text.trim();
                  Navigator.of(context).pop((category: _category!, what: what.isEmpty ? null : what));
                },
          child: const Text('Save'),
        ),
      ],
    );
  }
}

class _OtherDialog extends StatefulWidget {
  const _OtherDialog({required this.question, required this.categories});

  final ReviewQuestion question;
  final List<String> categories;

  @override
  State<_OtherDialog> createState() => _OtherDialogState();
}

class _OtherDialogState extends State<_OtherDialog> {
  final _text = TextEditingController();
  String? _category;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final income = widget.question.kind == 'income';
    return AlertDialog(
      title: Text(income ? 'What is this money?' : 'Who or what is this?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            key: const Key('other-text'),
            controller: _text,
            maxLength: 60,
            autofocus: true,
            decoration: InputDecoration(hintText: income ? 'e.g. rent from my tenant, side gig' : 'e.g. my landlady, my tailor, church'),
          ),
          DropdownButtonFormField<String?>(
            initialValue: _category,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Category'),
            items: [
              const DropdownMenuItem<String?>(value: null, child: Text('Let Ledger decide')),
              for (final c in widget.categories) DropdownMenuItem<String?>(value: c, child: Text(c)),
            ],
            onChanged: (value) => setState(() => _category = value),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          key: const Key('other-save'),
          onPressed: () {
            final text = _text.text.trim();
            if (text.isEmpty) return;
            Navigator.of(context).pop((text: text, category: _category));
          },
          child: const Text('Save'),
        ),
      ],
    );
  }
}
