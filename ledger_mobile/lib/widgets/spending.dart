import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../theme.dart';
import 'common.dart';

/// "6 payments need a purpose": shown when unlabelled person transfers are a big share of the month.
class ReviewCta extends StatelessWidget {
  const ReviewCta({super.key, required this.unlabelled, required this.currency, required this.onReview, this.onShowTransfers});

  final UnlabelledSpend unlabelled;
  final String currency;
  final VoidCallback onReview;

  /// Used when there are no Review questions left: label the rows from the list instead.
  final VoidCallback? onShowTransfers;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final n = unlabelled.count;
    final questions = unlabelled.reviewQuestions;
    final canReview = questions > 0;
    return Card(
      key: const Key('review-cta'),
      color: theme.colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('$n payment${n == 1 ? '' : 's'} need${n == 1 ? 's' : ''} a purpose — help Ledger label them', style: theme.textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(
              '${formatMinor(unlabelled.totalMinor, currency: currency)} went to people or transfers whose narration says who, not what for. '
              '${canReview ? 'Answer $questions question${questions == 1 ? '' : 's'} and Ledger labels every matching payment.' : 'Label them from the list and Ledger learns each name.'}',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            FilledButton(
              key: const Key('open-review'),
              onPressed: canReview ? onReview : onShowTransfers,
              child: Text(canReview ? 'Review now' : 'Show these payments'),
            ),
          ],
        ),
      ),
    );
  }
}

String regularLabel(String? kind) => switch (kind) {
  'fixed' => 'monthly',
  'variable' => 'monthly, varies',
  'frequent' => 'several times a month',
  _ => '',
};

class _Pill extends StatelessWidget {
  const _Pill(this.text, {this.filled = false});

  final String text;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: filled ? ledgerBlue : null,
        border: Border.all(color: filled ? ledgerBlue : theme.colorScheme.outline),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text, style: theme.textTheme.labelSmall?.copyWith(color: filled ? Colors.white : null)),
    );
  }
}

/// "What you spent on": one line per matched person or business, with every spelling folded in.
class PayeeList extends StatelessWidget {
  const PayeeList({super.key, required this.payees, required this.currency, this.onTap});

  final List<PayeeSpend> payees;
  final String currency;
  final void Function(PayeeSpend payee)? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (payees.isEmpty) return const EmptyNote('No spending in this month.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final p in payees)
          ListTile(
            key: Key('payee-${p.name}'),
            contentPadding: EdgeInsets.zero,
            onTap: p.unnamed || onTap == null ? null : () => onTap!(p),
            title: Text(p.name),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${p.label ?? p.category} · ${p.count} payment${p.count == 1 ? '' : 's'}', style: theme.textTheme.bodySmall),
                if (p.variants.isNotEmpty) Text('Also written as ${p.variants.join(', ')}', style: theme.textTheme.bodySmall),
                if (p.regular != null || p.unlabelledMinor != '0')
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        if (p.regular != null) _Pill(regularLabel(p.regular), filled: true),
                        if (p.unlabelledMinor != '0') const _Pill('no purpose yet'),
                      ],
                    ),
                  ),
              ],
            ),
            trailing: Text(formatMinor(p.totalMinor, currency: currency)),
          ),
      ],
    );
  }
}

/// Regular payments found by matched name: rent, family support, a shop paid every week.
class RecurringGroupList extends StatelessWidget {
  const RecurringGroupList({super.key, required this.groups, required this.currency, this.onTap});

  final List<RecurringGroup> groups;
  final String currency;
  final void Function(RecurringGroup group)? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (groups.isEmpty) return const EmptyNote('Nothing regular yet. Ledger needs two or more months of statements.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final g in groups)
          ListTile(
            key: Key('recurring-${g.name}'),
            contentPadding: EdgeInsets.zero,
            onTap: onTap == null ? null : () => onTap!(g),
            title: Text(g.name),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${g.label ?? g.category} · ${g.kindLabel} · ${g.months} months${g.bill ? ' · bill' : ''}', style: theme.textTheme.bodySmall),
                if (g.aliases.isNotEmpty) Text('Also written as ${g.aliases.join(', ')}', style: theme.textTheme.bodySmall),
              ],
            ),
            trailing: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(formatMinor(g.averageMinor, currency: currency)),
                Text(g.kind == 'frequent' ? 'a month' : 'each', style: theme.textTheme.bodySmall),
              ],
            ),
          ),
      ],
    );
  }
}

/// Everyday spending by category and by person or business, each line opening its transactions.
class EverydayBreakdownView extends StatelessWidget {
  const EverydayBreakdownView({super.key, required this.everyday, required this.currency, this.onCategory, this.onPayee});

  final EverydayBreakdown everyday;
  final String currency;
  final void Function(String category)? onCategory;
  final void Function(String payee)? onPayee;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (everyday.count == 0) return const EmptyNote('No everyday spending in this month.');
    final total = BigInt.parse(everyday.totalMinor);
    Widget bar(EverydayGroup g, void Function(String)? onTap, String prefix) {
      final share = total > BigInt.zero ? (BigInt.parse(g.totalMinor) * BigInt.from(1000) ~/ total).toInt() / 1000 : 0.0;
      return InkWell(
        key: Key('$prefix-${g.name}'),
        onTap: onTap == null ? null : () => onTap(g.name),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(child: Text('${g.name} · ${g.count}')),
                  Text(formatMinor(g.totalMinor, currency: currency)),
                ],
              ),
              const SizedBox(height: 4),
              LinearProgressIndicator(value: share.clamp(0.0, 1.0), minHeight: 6, borderRadius: BorderRadius.circular(3)),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('${everyday.count} payments · ${formatMinor(everyday.totalMinor, currency: currency)}', style: theme.textTheme.bodySmall),
        const SizedBox(height: 8),
        Text('By category', style: theme.textTheme.titleSmall),
        for (final g in everyday.byCategory) bar(g, onCategory, 'everyday-category'),
        if (everyday.byPayee.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('By person or business', style: theme.textTheme.titleSmall),
          for (final g in everyday.byPayee) bar(g, g.name == unnamedPayee ? null : onPayee, 'everyday-payee'),
        ],
      ],
    );
  }
}
