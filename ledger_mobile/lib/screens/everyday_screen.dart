import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
import '../widgets/spending.dart';
import 'review_screen.dart';
import 'transactions_screen.dart';

/// Everyday spending for one month: not recurring and not a one-off, by category and by who was paid.
class EverydayScreen extends StatefulWidget {
  const EverydayScreen({super.key, required this.summary});

  final HomeSummary summary;

  @override
  State<EverydayScreen> createState() => _EverydayScreenState();
}

class _EverydayScreenState extends State<EverydayScreen> {
  late HomeSummary _summary = widget.summary;
  TransactionPage? _page;
  String? _error;

  ({String? from, String? to}) get _days => TransactionQuery.days(_summary.periodFrom, _summary.periodTo);

  @override
  void initState() {
    super.initState();
    _loadRows();
  }

  Future<void> _loadRows() async {
    try {
      final page = await context.read<LedgerController>().transactions(cadence: 'everyday', from: _days.from, to: _days.to);
      if (!mounted) return;
      setState(() {
        _page = page;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _review() async {
    final changed = await openReview(context);
    if (!changed || !mounted) return;
    final offset = _monthOffset(_summary.periodFrom);
    try {
      final summary = await context.read<LedgerController>().summary(offset: offset);
      if (!mounted) return;
      setState(() => _summary = summary);
    } on ApiException {
      // Keep showing the figures already loaded.
    }
    await _loadRows();
  }

  void _open(String title, {String? category, String? payee}) {
    openTransactions(context, TransactionQuery(title: title, cadence: 'everyday', category: category, payee: payee, from: _days.from, to: _days.to));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final split = _summary.split;
    final everyday = split?.everyday;
    final unlabelled = split?.unlabelled;
    final currency = _summary.balanceCurrency;
    final page = _page;
    return Scaffold(
      appBar: AppBar(title: Text('Everyday · ${_summary.periodLabel}')),
      body: RefreshIndicator(
        onRefresh: _loadRows,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              'What you spent that is not a recurring payment or a big one-off: shops, food, transport, and people paid now and then.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            if (unlabelled != null && unlabelled.needsReview) ...[
              ReviewCta(
                unlabelled: unlabelled,
                currency: currency,
                onReview: _review,
                onShowTransfers: () => _open('Transfers with no purpose', category: 'Transfers'),
              ),
              const SizedBox(height: 12),
            ],
            if (split != null && !split.labelled)
              const EmptyNote('Ledger only splits the last six months, so this month has no everyday breakdown.')
            else if (everyday == null)
              const EmptyNote('Update the Ledger server to see the everyday breakdown.')
            else
              EverydayBreakdownView(
                everyday: everyday,
                currency: currency,
                onCategory: (category) => _open(category, category: category),
                onPayee: (payee) => _open(payee, payee: payee),
              ),
            const SizedBox(height: 16),
            Text('Everyday payments', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            if (_error != null) ErrorText(_error),
            if (page == null && _error == null) const Text('Loading…'),
            if (page != null) TransactionList(page: page),
          ],
        ),
      ),
    );
  }
}

/// Home's month offset for a period start, so the same month can be reloaded after Review.
int _monthOffset(DateTime? from) {
  if (from == null) return 0;
  final start = from.toUtc().add(const Duration(hours: 1));
  final now = DateTime.now().toUtc().add(const Duration(hours: 1));
  return (start.year - now.year) * 12 + start.month - now.month;
}
