import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/transaction_pager.dart';
import '../theme.dart';
import 'common.dart';

class PagedTransactionList extends StatefulWidget {
  const PagedTransactionList({super.key, required this.pager, this.header, this.empty = 'No transactions match.', this.onChanged});

  final TransactionPager pager;
  final Widget? header;
  final String empty;
  final VoidCallback? onChanged;

  @override
  State<PagedTransactionList> createState() => _PagedTransactionListState();
}

class _PagedTransactionListState extends State<PagedTransactionList> {
  bool _loadScheduled = false;

  @override
  void initState() {
    super.initState();
    widget.pager.refresh().then((_) {
      if (mounted) setState(() {});
      widget.onChanged?.call();
    });
  }

  Future<void> _refresh() async {
    await widget.pager.refresh();
    if (mounted) setState(() {});
    widget.onChanged?.call();
  }

  void _maybeMore() {
    if (!widget.pager.nearEnd || _loadScheduled) return;
    _loadScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      _loadScheduled = false;
      if (!mounted || !widget.pager.nearEnd) return;
      await widget.pager.loadMore();
      if (mounted) setState(() {});
      widget.onChanged?.call();
    });
  }

  @override
  Widget build(BuildContext context) {
    final pager = widget.pager;
    final groups = pager.groups;
    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification.metrics.extentAfter < 400) _maybeMore();
        return false;
      },
      child: RefreshIndicator(
        onRefresh: _refresh,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (widget.header != null) SliverToBoxAdapter(child: widget.header),
            if (pager.error != null)
              SliverToBoxAdapter(
                child: Padding(padding: const EdgeInsets.all(16), child: ErrorText(pager.error.toString())),
              ),
            if (pager.loading && pager.items.isEmpty)
              const SliverFillRemaining(hasScrollBody: false, child: Center(child: Text('Loading…'))),
            if (!pager.loading && pager.items.isEmpty && pager.error == null)
              SliverFillRemaining(hasScrollBody: false, child: EmptyNote(widget.empty)),
            for (final group in groups)
              SliverMainAxisGroup(
                slivers: [
                  PinnedHeaderSliver(child: _DayHeader(group: group)),
                  SliverList(
                    delegate: SliverChildBuilderDelegate((context, index) {
                      final remaining = pager.items.length - _indexOf(groups, group, index);
                      if (remaining <= 5) _maybeMore();
                      return CompactTransactionTile(transaction: group.rows[index]);
                    }, childCount: group.rows.length),
                  ),
                ],
              ),
            if (pager.loading && pager.items.isNotEmpty)
              const SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))),
            if (pager.done && pager.items.isNotEmpty)
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.fromLTRB(16, 8, 16, 32),
                  child: Center(child: Text("That's everything")),
                ),
              ),
          ],
        ),
      ),
    );
  }

  int _indexOf(List<DayGroup> groups, DayGroup group, int index) {
    var n = 0;
    for (final g in groups) {
      if (identical(g, group) || g.date == group.date && identical(g.rows, group.rows)) return n + index;
      n += g.rows.length;
    }
    return n + index;
  }
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.group});

  final DayGroup group;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final total = group.total;
    final net = total == null ? BigInt.zero : (BigInt.tryParse(total.netMinor) ?? BigInt.zero);
    return Material(
      color: theme.colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            Expanded(child: Text(formatLagosDayHeader(group.date), style: theme.textTheme.labelLarge)),
            if (total != null)
              Text(
                formatCompactMinor(total.netMinor),
                style: theme.textTheme.labelLarge?.copyWith(color: net < BigInt.zero ? theme.colorScheme.error : theme.colorScheme.onSurface),
              ),
          ],
        ),
      ),
    );
  }
}

class CompactTransactionTile extends StatelessWidget {
  const CompactTransactionTile({super.key, required this.transaction});

  final LedgerTransaction transaction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final debit = transaction.type == 'DEBIT';
    final amount = formatMinor(transaction.amountMinor, currency: transaction.currency);
    final masked = transaction.maskedAccountNumber;
    final time = formatLagosTime(transaction.transactionDate);
    final sub = [?masked, time].join(' · ');
    return InkWell(
      onTap: () => showTransactionSheet(context, transaction),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(transaction.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (sub.isNotEmpty) Text(sub, style: theme.textTheme.bodySmall),
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

Future<void> showTransactionSheet(BuildContext context, LedgerTransaction transaction) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (context) => TransactionDetailSheet(transaction: transaction),
  );
}

class TransactionDetailSheet extends StatelessWidget {
  const TransactionDetailSheet({super.key, required this.transaction});

  final LedgerTransaction transaction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final debit = transaction.type == 'DEBIT';
    final amount = formatMinor(transaction.amountMinor, currency: transaction.currency);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(transaction.title, style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              debit ? '-$amount' : amount,
              style: theme.textTheme.headlineSmall?.copyWith(color: debit ? theme.colorScheme.error : const Color(0xFF0F7B4C)),
            ),
            const SizedBox(height: 12),
            Text(transaction.description, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                _chip(context, transaction.category),
                if (transaction.subcategory != null) _chip(context, transaction.subcategory!),
                if (transaction.cadenceLabel != null) CadenceChip(transaction: transaction),
              ],
            ),
            const SizedBox(height: 12),
            if (transaction.maskedAccountNumber != null)
              Text('${transaction.institution ?? 'Account'} · ${transaction.maskedAccountNumber}', style: theme.textTheme.bodySmall),
            Text('${formatDay(transaction.transactionDate)} · ${formatLagosTime(transaction.transactionDate)}', style: theme.textTheme.bodySmall),
            if (transaction.destinationLabel != null && transaction.destinationLabel!.isNotEmpty)
              Text(transaction.destinationLabel!, style: theme.textTheme.bodySmall),
            if (transaction.conversionNote != null && transaction.conversionNote!.isNotEmpty)
              Text(transaction.conversionNote!, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }

  Widget _chip(BuildContext context, String text) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: theme.colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: theme.textTheme.labelSmall),
    );
  }
}

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
