import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
import '../widgets/spending.dart';
import 'everyday_screen.dart';
import 'review_screen.dart';
import 'transactions_screen.dart';

class SummaryScreen extends StatefulWidget {
  const SummaryScreen({super.key});

  @override
  State<SummaryScreen> createState() => _SummaryScreenState();
}

class _SummaryScreenState extends State<SummaryScreen> {
  HomeSummary? _summary;
  String? _error;
  bool _loading = true;
  int _offset = 0;
  String _span = 'month';
  int? _year;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final summary = await context.read<LedgerController>().summary(offset: _offset, span: _span, year: _year);
      if (!mounted) return;
      setState(() {
        _summary = summary;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final summary = _summary;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final item in const [
                ('month', 'This month'),
                ('3m', 'Last 3 months'),
                ('ytd', 'Year to date'),
                ('12m', 'Last 12 months'),
                ('all', 'All time'),
              ])
                ChoiceChip(
                  label: Text(item.$2),
                  selected: _span == item.$1,
                  onSelected: _loading
                      ? null
                      : (_) {
                          setState(() {
                            _span = item.$1;
                            _year = null;
                            if (item.$1 == 'month') {
                              // keep offset
                            } else {
                              _offset = 0;
                            }
                          });
                          _load();
                        },
                ),
              for (final year in summary?.availableYears ?? const <int>[])
                ChoiceChip(
                  label: Text('$year'),
                  selected: _span == 'year' && _year == year,
                  onSelected: _loading
                      ? null
                      : (_) {
                          setState(() {
                            _span = 'year';
                            _year = year;
                            _offset = 0;
                          });
                          _load();
                        },
                ),
            ],
          ),
          if (_span == 'month')
            Row(
              children: [
                IconButton(
                  tooltip: 'Previous month',
                  onPressed: _loading
                      ? null
                      : () {
                          setState(() => _offset -= 1);
                          _load();
                        },
                  icon: const Icon(Icons.chevron_left),
                ),
                Expanded(
                  child: Text(
                    summary?.periodLabel ?? 'This month',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: 'Next month',
                  onPressed: _loading || _offset >= 0
                      ? null
                      : () {
                          setState(() => _offset += 1);
                          _load();
                        },
                  icon: const Icon(Icons.chevron_right),
                ),
              ],
            )
          else
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 4),
              child: Text(
                summary?.periodLabel ?? 'Period',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Loading…'))),
          if (_error != null) ErrorText(_error),
          if (summary != null && !_loading) SummaryBody(summary: summary, onChanged: _load),
        ],
      ),
    );
  }
}

class SummaryBody extends StatelessWidget {
  const SummaryBody({super.key, required this.summary, this.onChanged});

  final HomeSummary summary;

  /// Called after Review saved an answer, so Home can reload.
  final VoidCallback? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final currency = summary.balanceCurrency;
    final days = TransactionQuery.days(summary.periodFrom, summary.periodTo);
    final payees = summary.split?.payees ?? const <PayeeSpend>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          mainAxisExtent: 112,
          children: [
            StatTile(label: 'Balance', minor: summary.balanceMinor, currency: currency),
            StatTile(label: 'Income', minor: summary.incomeMinor, currency: currency),
            StatTile(label: 'Expenses', minor: summary.expensesMinor, currency: currency),
            StatTile(
              label: 'Net',
              minor: summary.netMinor,
              currency: currency,
              hint: summary.savingsRate == null
                  ? '${summary.count} transactions'
                  : '${summary.count} transactions · saved ${(summary.savingsRate! * 100).toStringAsFixed(0)}%',
            ),
          ],
        ),
        if (summary.monthlyTrend.length > 1) ...[
          const SizedBox(height: 16),
          Text('Income vs expenses', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final row in summary.monthlyTrend)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(row.label),
              subtitle: Text('In ${formatMinor(row.incomeMinor, currency: currency)} · out ${formatMinor(row.expensesMinor, currency: currency)}'),
            ),
        ],
        if (summary.incomeSources.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Income by source', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final row in summary.incomeSources)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(row.name),
              subtitle: Text('${row.kind} · ${row.count} payment${row.count == 1 ? '' : 's'}'),
              trailing: Text(formatMinor(row.totalMinor, currency: currency)),
            ),
        ],
        if (summary.split case final split?) ...[
          const SizedBox(height: 16),
          SpendingSplitSection(split: split, currency: currency, summary: summary, onChanged: onChanged),
        ],
        if (payees.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('What you spent on', style: theme.textTheme.titleMedium),
          Text('Each person or business once, every spelling of the name matched.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 4),
          PayeeList(
            payees: payees,
            currency: currency,
            onTap: (p) => openTransactions(context, TransactionQuery(title: p.name, payee: p.name, type: 'DEBIT', from: days.from, to: days.to)),
          ),
        ],
        if (summary.recurring.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Recurring, by name', style: theme.textTheme.titleMedium),
          Text('Paid in two or more months, or several times a month, over the last six months.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 4),
          RecurringGroupList(
            groups: summary.recurring,
            currency: currency,
            onTap: (g) => openTransactions(context, TransactionQuery(title: g.name, payee: g.name, type: 'DEBIT')),
          ),
        ],
        const SizedBox(height: 16),
        Text('Spending by category', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (summary.spending.isEmpty) const EmptyNote('No spending in this month.'),
        for (final row in summary.spending)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(row.category),
            subtitle: Text(_categoryNote(row, currency)),
            trailing: Text(formatMinor(row.totalMinor, currency: currency)),
          ),
        const SizedBox(height: 8),
        Text('Recent', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (summary.recent.isEmpty) const EmptyNote('No transactions yet. Upload a statement to start.'),
        for (final tx in summary.recent) TransactionTile(transaction: tx),
      ],
    );
  }

  static String _categoryNote(CategorySpend row, String currency) {
    final parts = ['${row.count}'];
    if (row.recurringMinor != '0') parts.add('${formatMinor(row.recurringMinor, currency: currency)} recurring');
    if (row.oneOffMinor != '0') parts.add('${formatMinor(row.oneOffMinor, currency: currency)} one-off');
    return parts.join(' · ');
  }
}

/// The same split Afford uses, so its advice can be checked against the month.
class SpendingSplitSection extends StatelessWidget {
  const SpendingSplitSection({super.key, required this.split, required this.currency, this.summary, this.onChanged});

  final SpendingSplit split;
  final String currency;

  /// The month this split belongs to; tiles open its transactions when set.
  final HomeSummary? summary;
  final VoidCallback? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final month = summary;
    final days = TransactionQuery.days(month?.periodFrom, month?.periodTo);
    final unlabelled = split.unlabelled;
    VoidCallback? list(String title, String cadence) => month == null
        ? null
        : () => openTransactions(context, TransactionQuery(title: title, cadence: cadence, type: 'DEBIT', from: days.from, to: days.to));
    void everydayList(String title, {String? category, String? payee}) {
      openTransactions(context, TransactionQuery(title: title, cadence: 'everyday', category: category, payee: payee, from: days.from, to: days.to));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (unlabelled != null && unlabelled.needsReview) ...[
          ReviewCta(
            unlabelled: unlabelled,
            currency: currency,
            onReview: () async {
              if (await openReview(context)) onChanged?.call();
            },
            onShowTransfers: () => openTransactions(
              context,
              TransactionQuery(title: 'Transfers with no purpose', category: 'Transfers', type: 'DEBIT', from: days.from, to: days.to),
            ),
          ),
          const SizedBox(height: 12),
        ],
        Text('Recurring vs one-off', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        if (!split.labelled)
          const EmptyNote('Afford only labels the last six months, so this month is not split.')
        else ...[
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            mainAxisExtent: 120,
            children: [
              StatTile(
                label: 'Recurring bills',
                minor: split.recurringBillsMinor,
                currency: currency,
                hint: 'Rent, loans, family',
                onTap: list('Recurring', 'recurring'),
              ),
              StatTile(label: 'Other recurring', minor: split.recurringOtherMinor, currency: currency, onTap: list('Recurring', 'recurring')),
              StatTile(
                label: 'One-off',
                minor: split.oneOffMinor,
                currency: currency,
                hint: 'Each ${formatMinor(split.oneOffMinMinor, currency: currency)}+',
                onTap: list('One-off', 'one_off'),
              ),
              StatTile(
                key: const Key('everyday-tile'),
                label: 'Everyday',
                minor: split.everydayMinor,
                currency: currency,
                hint: split.everyday == null ? null : 'Tap for the breakdown',
                onTap: month == null ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => EverydayScreen(summary: month))),
              ),
            ],
          ),
          if (split.everyday case final everyday? when everyday.count > 0) ...[
            const SizedBox(height: 12),
            Text('Everyday spending', style: theme.textTheme.titleSmall),
            EverydayBreakdownView(
              everyday: everyday,
              currency: currency,
              onCategory: month == null ? null : (c) => everydayList(c, category: c),
              onPayee: month == null ? null : (p) => everydayList(p, payee: p),
            ),
            const SizedBox(height: 8),
          ],
          for (final oneOff in split.oneOffs)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: Text(oneOff.name),
              subtitle: Text('${oneOff.category}${oneOff.subcategory == null ? '' : ' · ${oneOff.subcategory}'} · ${formatDay(oneOff.date)}'),
              trailing: Text(formatMinor(oneOff.amountMinor, currency: currency)),
            ),
          Text(
            'Recurring means the same person or business, matched by name, paid in two or more months or several times a month. '
            'One-offs already happened and are not bills. Everyday is everything else.',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ],
    );
  }
}
