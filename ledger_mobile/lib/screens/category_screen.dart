import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'transactions_screen.dart';

void openCategory(BuildContext context, String category, String month) {
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CategoryScreen(category: category, month: month)));
}

class CategoryScreen extends StatefulWidget {
  const CategoryScreen({super.key, required this.category, required this.month});

  final String category;
  final String month;

  @override
  State<CategoryScreen> createState() => _CategoryScreenState();
}

class _CategoryScreenState extends State<CategoryScreen> {
  CategoryDetail? _detail;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final detail = await context.read<LedgerController>().categoryMonth(category: widget.category, month: widget.month);
      if (!mounted) return;
      if (detail.subcategories.length == 1) {
        final only = detail.subcategories.single;
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => FilteredTransactionsScreen(
              query: TransactionQuery(
                title: '${widget.category} · ${only.name}',
                category: widget.category,
                subcategory: only.name,
                month: widget.month,
                type: widget.category == 'Income' ? 'CREDIT' : 'DEBIT',
              ),
            ),
          ),
        );
        return;
      }
      setState(() {
        _detail = detail;
        _error = null;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    return Scaffold(
      appBar: AppBar(title: Text('${widget.category} · ${shortMonthName(widget.month)} ${widget.month.substring(0, 4)}')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            if (_error != null) ErrorText(_error),
            if (detail == null && _error == null) const Center(child: Text('Loading…')),
            if (detail != null) ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${widget.category.toUpperCase()} THIS MONTH', style: Theme.of(context).textTheme.labelSmall),
                      const SizedBox(height: 6),
                      Text(formatMinor(detail.totalMinor), style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: 4),
                      Text(
                        '${percentFromBp(detail.shareBp)}% of Out · avg ${formatCompactMinor(detail.avg6mMinor)}/mo over 6 months',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text('Subcategories', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              if (detail.subcategories.isEmpty) const EmptyNote('No payments in this category this month.'),
              Builder(
                builder: (context) {
                  final biggest = detail.subcategories.isEmpty
                      ? BigInt.one
                      : detail.subcategories.map((s) => BigInt.tryParse(s.totalMinor) ?? BigInt.zero).fold<BigInt>(BigInt.zero, (a, b) => a > b ? a : b);
                  final denom = biggest > BigInt.zero ? biggest : BigInt.one;
                  return Column(
                    children: [
                      for (final sub in detail.subcategories)
                        _SubcategoryRow(
                          row: sub,
                          share: (BigInt.tryParse(sub.totalMinor) ?? BigInt.zero).toDouble() / denom.toDouble(),
                          onTap: () => openTransactions(
                            context,
                            TransactionQuery(
                              title: sub.name,
                              category: widget.category,
                              subcategory: sub.name,
                              month: widget.month,
                              type: widget.category == 'Income' ? 'CREDIT' : 'DEBIT',
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
            ],
            if (detail != null && detail.subcategories.isEmpty)
              ListTile(
                title: const Text('All payments'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => openTransactions(
                  context,
                  TransactionQuery(
                    title: widget.category,
                    category: widget.category,
                    month: widget.month,
                    type: widget.category == 'Income' ? 'CREDIT' : 'DEBIT',
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SubcategoryRow extends StatelessWidget {
  const _SubcategoryRow({required this.row, required this.share, required this.onTap});

  final CategorySubtotal row;
  final double share;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      key: Key('subcategory-${row.name}'),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(row.name, style: theme.textTheme.titleSmall)),
                Text(formatCompactMinor(row.totalMinor), style: theme.textTheme.titleSmall),
                const Icon(Icons.chevron_right, size: 18),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: LinearProgressIndicator(
                value: share.clamp(0, 1),
                minHeight: 8,
                color: ledgerBlue,
                backgroundColor: theme.colorScheme.surfaceContainerHighest,
              ),
            ),
            const SizedBox(height: 4),
            Text('${row.count} payment${row.count == 1 ? '' : 's'}', style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}
