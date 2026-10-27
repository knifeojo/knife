import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'everyday_screen.dart';

class TransactionsScreen extends StatefulWidget {
  const TransactionsScreen({super.key});

  @override
  State<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends State<TransactionsScreen> {
  final _query = TextEditingController();
  TransactionPage? _page;
  String? _category;
  String? _cadence;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await context.read<LedgerController>().transactions(category: _category, query: _query.text.trim(), cadence: _cadence);
      if (!mounted) return;
      setState(() {
        _page = page;
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
    final page = _page;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _query,
            decoration: const InputDecoration(labelText: 'Search', hintText: 'Merchant, person, reference'),
            onSubmitted: (_) => _load(),
          ),
          const SizedBox(height: 12),
          if (page != null)
            DropdownButtonFormField<String?>(
              initialValue: _category,
              decoration: const InputDecoration(labelText: 'Category'),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('All categories')),
                for (final category in page.categories) DropdownMenuItem<String?>(value: category, child: Text(category)),
              ],
              onChanged: (value) {
                setState(() => _category = value);
                _load();
              },
            ),
          if (page != null) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String?>(
              key: const Key('cadence-filter'),
              initialValue: _cadence,
              decoration: const InputDecoration(
                labelText: 'Pattern',
                helperText:
                    'Recurring: the same person or business, matched by name, paid in 2+ months or several times a month. '
                    'One-off: a big single spend. Everyday: everything else you spent.',
                helperMaxLines: 3,
              ),
              items: const [
                DropdownMenuItem<String?>(value: null, child: Text('Any pattern')),
                DropdownMenuItem<String?>(value: 'recurring', child: Text('Recurring')),
                DropdownMenuItem<String?>(value: 'one_off', child: Text('One-off')),
                DropdownMenuItem<String?>(value: 'everyday', child: Text('Everyday spending')),
              ],
              onChanged: (value) {
                setState(() => _cadence = value);
                _load();
              },
            ),
          ],
          if (_cadence == 'everyday') ...[
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const Key('everyday-breakdown'),
              onPressed: () => openEverydayThisMonth(context),
              icon: const Icon(Icons.pie_chart_outline),
              label: const Text('This month by category and payee'),
            ),
          ],
          const SizedBox(height: 12),
          if (_loading) const Center(child: Text('Loading…')),
          if (_error != null) ErrorText(_error),
          if (page != null && !_loading) TransactionList(page: page),
        ],
      ),
    );
  }
}

/// Filters for a pushed list: one payee, one category of everyday spending, one period.
class TransactionQuery {
  const TransactionQuery({required this.title, this.cadence, this.payee, this.category, this.type, this.from, this.to});

  final String title;
  final String? cadence;
  final String? payee;
  final String? category;
  final String? type;

  /// Inclusive Lagos days, YYYY-MM-DD.
  final String? from;
  final String? to;

  /// A Home period (to is exclusive) as inclusive Lagos days.
  static ({String? from, String? to}) days(DateTime? from, DateTime? to) {
    return (from: from == null ? null : lagosDay(from), to: to == null ? null : lagosDay(to.subtract(const Duration(milliseconds: 1))));
  }
}

void openTransactions(BuildContext context, TransactionQuery query) {
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FilteredTransactionsScreen(query: query)));
}

/// Loads this month's summary and opens its everyday breakdown.
Future<void> openEverydayThisMonth(BuildContext context) async {
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);
  try {
    final summary = await context.read<LedgerController>().summary();
    navigator.push(MaterialPageRoute<void>(builder: (_) => EverydayScreen(summary: summary)));
  } on ApiException catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(error.message)));
  }
}

class FilteredTransactionsScreen extends StatefulWidget {
  const FilteredTransactionsScreen({super.key, required this.query});

  final TransactionQuery query;

  @override
  State<FilteredTransactionsScreen> createState() => _FilteredTransactionsScreenState();
}

class _FilteredTransactionsScreenState extends State<FilteredTransactionsScreen> {
  TransactionPage? _page;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final q = widget.query;
    try {
      final page = await context.read<LedgerController>().transactions(
        cadence: q.cadence,
        payee: q.payee,
        category: q.category,
        type: q.type,
        from: q.from,
        to: q.to,
      );
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

  @override
  Widget build(BuildContext context) {
    final page = _page;
    return Scaffold(
      appBar: AppBar(title: Text(widget.query.title)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            if (widget.query.payee != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text('Every spelling of this name is included.', style: Theme.of(context).textTheme.bodySmall),
              ),
            if (_error != null) ErrorText(_error),
            if (page == null && _error == null) const Center(child: Text('Loading…')),
            if (page != null) TransactionList(page: page),
          ],
        ),
      ),
    );
  }
}

class TransactionList extends StatelessWidget {
  const TransactionList({super.key, required this.page});

  final TransactionPage page;

  @override
  Widget build(BuildContext context) {
    if (page.transactions.isEmpty) return const EmptyNote('No transactions match.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('${page.total} transactions', style: Theme.of(context).textTheme.bodySmall),
        for (final tx in page.transactions) TransactionTile(transaction: tx),
        if (page.total > page.transactions.length)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('Showing ${page.transactions.length} of ${page.total}.'),
          ),
      ],
    );
  }
}

/// Recurring rows get a filled brand-blue chip; one-offs an outlined one, as on the web.
class CadenceChip extends StatelessWidget {
  const CadenceChip({super.key, required this.transaction});

  final LedgerTransaction transaction;

  @override
  Widget build(BuildContext context) {
    final recurring = transaction.cadence == 'recurring';
    final style = Theme.of(context).textTheme.labelSmall?.copyWith(color: recurring ? Colors.white : ledgerBlue);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: recurring ? ledgerBlue : null,
        border: Border.all(color: ledgerBlue),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(transaction.cadenceLabel!, style: style),
    );
  }
}

class TransactionTile extends StatelessWidget {
  const TransactionTile({super.key, required this.transaction});

  final LedgerTransaction transaction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final debit = transaction.type == 'DEBIT';
    final amount = formatMinor(transaction.amountMinor, currency: transaction.currency);
    final masked = transaction.maskedAccountNumber;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(transaction.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text('${formatDay(transaction.transactionDate)}${masked == null ? '' : ' · $masked'}', style: theme.textTheme.bodySmall),
                if (transaction.destinationLabel != null && transaction.destinationLabel!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(transaction.destinationLabel!, style: theme.textTheme.bodySmall),
                ],
                if (transaction.conversionNote != null && transaction.conversionNote!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(transaction.conversionNote!, style: theme.textTheme.bodySmall),
                ],
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(color: theme.colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(999)),
                      child: Text(transaction.category, style: theme.textTheme.labelSmall),
                    ),
                    if (transaction.cadenceLabel != null) CadenceChip(transaction: transaction),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(
            debit ? '−$amount' : amount,
            style: theme.textTheme.bodyMedium?.copyWith(color: debit ? theme.colorScheme.error : const Color(0xFF0F7B4C)),
          ),
        ],
      ),
    );
  }
}
