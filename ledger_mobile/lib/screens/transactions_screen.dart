import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../state/transaction_pager.dart';
import '../widgets/common.dart';
import '../widgets/paged_transactions.dart';
import 'everyday_screen.dart';

export '../widgets/paged_transactions.dart' show CadenceChip, CompactTransactionTile, showTransactionSheet;

class TransactionsScreen extends StatefulWidget {
  const TransactionsScreen({super.key});

  @override
  State<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends State<TransactionsScreen> {
  final _query = TextEditingController();
  String? _direction;
  String? _category;
  String? _month;
  String? _cadence;
  late TransactionPager _pager;

  @override
  void initState() {
    super.initState();
    _pager = TransactionPager(_fetch);
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  Future<TransactionPage> _fetch({String? cursor}) {
    return context.read<LedgerController>().transactions(
      category: _category,
      query: _query.text.trim(),
      cadence: _cadence,
      direction: _direction,
      month: _month,
      cursor: cursor,
    );
  }

  void _reload() {
    setState(() => _pager = TransactionPager(_fetch));
  }

  @override
  Widget build(BuildContext context) {
    return PagedTransactionList(
      key: ObjectKey(_pager),
      pager: _pager,
      onChanged: () {
        if (mounted) setState(() {});
      },
      header: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _query,
              decoration: const InputDecoration(labelText: 'Search', hintText: 'Merchant, person, reference'),
              onSubmitted: (_) => _reload(),
            ),
            const SizedBox(height: 8),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final item in const [(null, 'All'), ('out', 'Out'), ('in', 'In')])
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(item.$2),
                        selected: _direction == item.$1,
                        onSelected: (_) {
                          setState(() => _direction = item.$1);
                          _reload();
                        },
                      ),
                    ),
                  const SizedBox(width: 8),
                  DropdownButton<String?>(
                    value: _category,
                    hint: const Text('Category'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('All categories')),
                      for (final category in _pager.categories) DropdownMenuItem<String?>(value: category, child: Text(category)),
                    ],
                    onChanged: (value) {
                      setState(() => _category = value);
                      _reload();
                    },
                  ),
                  const SizedBox(width: 8),
                  DropdownButton<String?>(
                    value: _month,
                    hint: const Text('Month'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('Any month')),
                      for (var i = 0; i <= 12; i++)
                        DropdownMenuItem<String?>(
                          value: shiftYearMonth(lagosYearMonth(DateTime.now()), -i),
                          child: Text(formatYearMonth(shiftYearMonth(lagosYearMonth(DateTime.now()), -i))),
                        ),
                    ],
                    onChanged: (value) {
                      setState(() => _month = value);
                      _reload();
                    },
                  ),
                  TextButton(
                    onPressed: () async {
                      final value = await showModalBottomSheet<String?>(
                        context: context,
                        builder: (context) => SafeArea(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const ListTile(title: Text('More filters')),
                              ListTile(title: const Text('Any pattern'), onTap: () => Navigator.pop(context, '')),
                              ListTile(title: const Text('Recurring'), onTap: () => Navigator.pop(context, 'recurring')),
                              ListTile(title: const Text('One-off'), onTap: () => Navigator.pop(context, 'one_off')),
                              ListTile(key: const Key('cadence-filter'), title: const Text('Everyday spending'), onTap: () => Navigator.pop(context, 'everyday')),
                            ],
                          ),
                        ),
                      );
                      if (value == null) return;
                      setState(() => _cadence = value.isEmpty ? null : value);
                      _reload();
                    },
                    child: const Text('More filters'),
                  ),
                ],
              ),
            ),
            if (_cadence == 'everyday')
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: OutlinedButton.icon(
                  key: const Key('everyday-breakdown'),
                  onPressed: () => openEverydayThisMonth(context),
                  icon: const Icon(Icons.pie_chart_outline),
                  label: const Text('This month by category and payee'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Filters for a pushed list: one payee, one category of everyday spending, one period.
class TransactionQuery {
  const TransactionQuery({
    required this.title,
    this.cadence,
    this.payee,
    this.category,
    this.subcategory,
    this.type,
    this.direction,
    this.from,
    this.to,
    this.month,
  });

  final String title;
  final String? cadence;
  final String? payee;
  final String? category;
  final String? subcategory;
  final String? type;
  final String? direction;

  /// Inclusive Lagos days, YYYY-MM-DD.
  final String? from;
  final String? to;
  final String? month;

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
  late final TransactionPager _pager;

  @override
  void initState() {
    super.initState();
    _pager = TransactionPager(_fetch);
  }

  Future<TransactionPage> _fetch({String? cursor}) {
    final q = widget.query;
    return context.read<LedgerController>().transactions(
      cadence: q.cadence,
      payee: q.payee,
      category: q.category,
      subcategory: q.subcategory,
      type: q.type,
      direction: q.direction,
      from: q.from,
      to: q.to,
      month: q.month,
      cursor: cursor,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.query.title)),
      body: PagedTransactionList(
        pager: _pager,
        header: widget.query.payee == null
            ? null
            : Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Text('Every spelling of this name is included.', style: Theme.of(context).textTheme.bodySmall),
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
        if (page.total != null) Text('${page.total} transactions', style: Theme.of(context).textTheme.bodySmall),
        for (final tx in page.transactions) TransactionTile(transaction: tx),
        if (page.total != null && page.total! > page.transactions.length)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('Showing ${page.transactions.length} of ${page.total}.'),
          ),
      ],
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
    return InkWell(
      onTap: () => showTransactionSheet(context, transaction),
      child: Padding(
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
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(
              debit ? '-$amount' : amount,
              style: theme.textTheme.bodyMedium?.copyWith(color: debit ? theme.colorScheme.error : const Color(0xFF0F7B4C)),
            ),
          ],
        ),
      ),
    );
  }
}
