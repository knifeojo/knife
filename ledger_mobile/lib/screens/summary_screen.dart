import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
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
      final summary = await context.read<LedgerController>().summary(offset: _offset);
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
          ),
          if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Loading…'))),
          if (_error != null) ErrorText(_error),
          if (summary != null && !_loading) SummaryBody(summary: summary),
        ],
      ),
    );
  }
}

class SummaryBody extends StatelessWidget {
  const SummaryBody({super.key, required this.summary});

  final HomeSummary summary;

  @override
  Widget build(BuildContext context) {
    final currency = summary.balanceCurrency;
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
            StatTile(label: 'Net', minor: summary.netMinor, currency: currency, hint: '${summary.count} transactions'),
          ],
        ),
        const SizedBox(height: 16),
        Text('Spending by category', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (summary.spending.isEmpty) const EmptyNote('No spending in this month.'),
        for (final row in summary.spending)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(row.category),
            subtitle: Text('${row.count}'),
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
}
