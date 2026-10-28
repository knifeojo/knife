import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
import '../widgets/spending.dart';
import 'everyday_screen.dart';
import 'summary_screen.dart';
import 'transactions_screen.dart';

void openInsights(BuildContext context) {
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const InsightsScreen()));
}

/// Former Home sections, each collapsed to a header and one number.
class InsightsScreen extends StatefulWidget {
  const InsightsScreen({super.key});

  @override
  State<InsightsScreen> createState() => _InsightsScreenState();
}

class _InsightsScreenState extends State<InsightsScreen> {
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
    return Scaffold(
      appBar: AppBar(title: const Text('Insights')),
      body: RefreshIndicator(
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
                    child: Text(summary?.periodLabel ?? 'This month', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
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
              ),
            if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Loading…'))),
            if (_error != null) ErrorText(_error),
            if (summary != null && !_loading) InsightsSections(summary: summary, onChanged: _load),
          ],
        ),
      ),
    );
  }
}

class InsightsSections extends StatelessWidget {
  const InsightsSections({super.key, required this.summary, this.onChanged});

  final HomeSummary summary;
  final VoidCallback? onChanged;

  @override
  Widget build(BuildContext context) {
    final currency = summary.balanceCurrency;
    final days = TransactionQuery.days(summary.periodFrom, summary.periodTo);
    final split = summary.split;
    final payees = split?.payees ?? const <PayeeSpend>[];
    return Column(
      children: [
        _tile(
          context,
          title: 'Income vs expenses',
          number: '${formatCompactMinor(summary.incomeMinor)} in',
          child: summary.monthlyTrend.length <= 1
              ? const EmptyNote('Not enough months to chart yet.')
              : Column(
                  children: [
                    for (final row in summary.monthlyTrend)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(row.label),
                        subtitle: Text('In ${formatMinor(row.incomeMinor, currency: currency)} · out ${formatMinor(row.expensesMinor, currency: currency)}'),
                      ),
                  ],
                ),
        ),
        if (split != null)
          _tile(
            context,
            title: 'Recurring vs one-off',
            number: formatCompactMinor(split.recurringBillsMinor, currency: currency),
            child: SpendingSplitSection(split: split, currency: currency, summary: summary, onChanged: onChanged),
          ),
        _tile(
          context,
          title: 'Recurring, by name',
          number: '${summary.recurring.length} stream${summary.recurring.length == 1 ? '' : 's'}',
          child: summary.recurring.isEmpty
              ? const EmptyNote('No recurring payments in the last six months.')
              : RecurringGroupList(
                  groups: summary.recurring,
                  currency: currency,
                  onTap: (g) => openTransactions(context, TransactionQuery(title: g.name, payee: g.name, type: 'DEBIT')),
                ),
        ),
        if (split != null && split.oneOffs.isNotEmpty)
          _tile(
            context,
            title: 'One-offs',
            number: formatCompactMinor(split.oneOffMinor, currency: currency),
            child: Column(
              children: [
                for (final oneOff in split.oneOffs)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: Text(oneOff.name),
                    subtitle: Text('${oneOff.category}${oneOff.subcategory == null ? '' : ' · ${oneOff.subcategory}'} · ${formatDay(oneOff.date)}'),
                    trailing: Text(formatMinor(oneOff.amountMinor, currency: currency)),
                  ),
              ],
            ),
          ),
        if (split?.everyday != null)
          _tile(
            context,
            title: 'Everyday',
            number: formatCompactMinor(split!.everydayMinor, currency: currency),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                EverydayBreakdownView(
                  everyday: split.everyday!,
                  currency: currency,
                  onCategory: (c) => openTransactions(context, TransactionQuery(title: c, cadence: 'everyday', category: c, from: days.from, to: days.to)),
                  onPayee: (p) => openTransactions(context, TransactionQuery(title: p, cadence: 'everyday', payee: p, from: days.from, to: days.to)),
                ),
                TextButton(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => EverydayScreen(summary: summary))),
                  child: const Text('Full breakdown'),
                ),
              ],
            ),
          ),
        if (payees.isNotEmpty)
          _tile(
            context,
            title: 'Payees',
            number: '${payees.length} people and businesses',
            child: PayeeList(
              payees: payees,
              currency: currency,
              onTap: (p) => openTransactions(context, TransactionQuery(title: p.name, payee: p.name, type: 'DEBIT', from: days.from, to: days.to)),
            ),
          ),
        _tile(
          context,
          title: 'Spending by category',
          number: '${summary.spending.length} categor${summary.spending.length == 1 ? 'y' : 'ies'}',
          child: Column(
            children: [
              if (summary.spending.isEmpty) const EmptyNote('No spending in this period.'),
              for (final row in summary.spending)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(row.category),
                  trailing: Text(formatMinor(row.totalMinor, currency: currency)),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _tile(BuildContext context, {required String title, required String number, required Widget child}) {
    return Card(
      margin: const EdgeInsets.only(top: 12),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          title: Text(title),
          subtitle: Text(number),
          children: [Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), child: child)],
        ),
      ),
    );
  }
}
