import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'category_screen.dart';
import 'income_sources_screen.dart';
import 'review_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late String _month;
  MonthOverview? _overview;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _month = lagosYearMonth(DateTime.now());
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final overview = await context.read<LedgerController>().overview(month: _month);
      if (!mounted) return;
      setState(() {
        _overview = overview;
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

  void _shift(int delta) {
    final next = shiftYearMonth(_month, delta);
    if (delta > 0 && next.compareTo(lagosYearMonth(DateTime.now())) > 0) return;
    setState(() => _month = next);
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final overview = _overview;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              IconButton(tooltip: 'Previous month', onPressed: _loading ? null : () => _shift(-1), icon: const Icon(Icons.chevron_left)),
              Expanded(
                child: Text(
                  overview?.periodLabel.isNotEmpty == true ? overview!.periodLabel : formatYearMonth(_month),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: 'Next month',
                onPressed: _loading || _month.compareTo(lagosYearMonth(DateTime.now())) >= 0 ? null : () => _shift(1),
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          if (_loading) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text('Loading…'))),
          if (_error != null) ErrorText(_error),
          if (overview != null && !_loading) HomeBody(overview: overview, month: _month, onChanged: _load),
        ],
      ),
    );
  }
}

class HomeBody extends StatelessWidget {
  const HomeBody({super.key, required this.overview, required this.month, this.onChanged});

  final MonthOverview overview;
  final String month;
  final VoidCallback? onChanged;

  @override
  Widget build(BuildContext context) {
    final out = BigInt.tryParse(overview.outMinor) ?? BigInt.zero;
    final top = overview.categories.take(5).toList();
    final rest = overview.categories.skip(5).fold<BigInt>(BigInt.zero, (sum, row) => sum + (BigInt.tryParse(row.totalMinor) ?? BigInt.zero));
    final empty = out <= BigInt.zero && overview.categories.isEmpty;
    final prevHint = (BigInt.tryParse(overview.prevOutMinor) ?? BigInt.zero) > BigInt.zero
        ? 'vs ${formatCompactMinor(overview.prevOutMinor)} ${shortMonthName(shiftYearMonth(month, -1))}'
        : null;
    final kept = overview.keptBp == null ? null : '${percentFromBp(overview.keptBp!)}% kept';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: HomeStatCard(
                key: const Key('home-in'),
                label: 'IN',
                minor: overview.inMinor,
                onTap: () => openIncomeSources(context, overview, month),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: HomeStatCard(
                key: const Key('home-out'),
                label: 'OUT',
                minor: overview.outMinor,
                hint: prevHint,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: HomeStatCard(
                key: const Key('home-left'),
                label: 'LEFT',
                minor: overview.leftMinor,
                hint: kept,
                filled: true,
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(child: Text('Where it went', style: Theme.of(context).textTheme.titleMedium)),
            if (overview.categories.length > 5)
              Text('tap to see more', style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
        const SizedBox(height: 8),
        if (empty)
          EmptyNote('No spending yet in ${overview.periodLabel.split(' ').first}. Bank texts and emails appear here automatically.')
        else
          WhereItWentList(categories: top, month: month),
        if (overview.categories.isNotEmpty) ...[
          const SizedBox(height: 4),
          ListTile(
            key: const Key('all-categories'),
            contentPadding: EdgeInsets.zero,
            title: Text('All ${overview.categories.length} categor${overview.categories.length == 1 ? 'y' : 'ies'}', style: TextStyle(color: ledgerBlue)),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (rest > BigInt.zero) Text('+${formatCompactMinor(rest.toString())}', style: TextStyle(color: ledgerBlue)),
                Icon(Icons.chevron_right, color: ledgerBlue),
              ],
            ),
            onTap: () => openAllCategories(context, overview, month),
          ),
        ],
        if (overview.reviewCount > 0) ...[
          const SizedBox(height: 8),
          Material(
            key: const Key('review-chip'),
            color: Theme.of(context).colorScheme.primaryContainer,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              onTap: () async {
                if (await openReview(context)) onChanged?.call();
              },
              borderRadius: BorderRadius.circular(12),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${overview.reviewCount} question${overview.reviewCount == 1 ? '' : 's'} to review',
                      ),
                    ),
                    Text('Review', style: TextStyle(color: ledgerBlue, fontWeight: FontWeight.w600)),
                    Icon(Icons.chevron_right, size: 18, color: ledgerBlue),
                  ],
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class HomeStatCard extends StatelessWidget {
  const HomeStatCard({super.key, required this.label, required this.minor, this.hint, this.onTap, this.filled = false});

  final String label;
  final String minor;
  final String? hint;
  final VoidCallback? onTap;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final fg = filled ? Colors.white : theme.colorScheme.onSurface;
    final muted = filled ? Colors.white70 : theme.colorScheme.onSurfaceVariant;
    return Card(
      color: filled ? ledgerBlue : null,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: theme.textTheme.labelSmall?.copyWith(color: muted, letterSpacing: 0.4)),
              const SizedBox(height: 6),
              Text(formatCompactMinor(minor), style: theme.textTheme.titleMedium?.copyWith(color: fg, fontWeight: FontWeight.w700)),
              if (hint != null) ...[
                const SizedBox(height: 4),
                Text(hint!, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: muted)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class WhereItWentList extends StatelessWidget {
  const WhereItWentList({super.key, required this.categories, required this.month});

  final List<OverviewCategory> categories;
  final String month;

  @override
  Widget build(BuildContext context) {
    final biggest = categories.isEmpty ? BigInt.one : categories.map((c) => BigInt.tryParse(c.totalMinor) ?? BigInt.zero).fold<BigInt>(BigInt.zero, (a, b) => a > b ? a : b);
    final denom = biggest > BigInt.zero ? biggest : BigInt.one;
    return Column(
      children: [
        for (var i = 0; i < categories.length; i++)
          WhereItWentRow(
            rank: i + 1,
            row: categories[i],
            shareOfBiggest: denom == BigInt.zero ? 0 : (BigInt.tryParse(categories[i].totalMinor) ?? BigInt.zero).toDouble() / denom.toDouble(),
            month: month,
          ),
      ],
    );
  }
}

class WhereItWentRow extends StatelessWidget {
  const WhereItWentRow({super.key, required this.rank, required this.row, required this.shareOfBiggest, required this.month});

  final int rank;
  final OverviewCategory row;
  final double shareOfBiggest;
  final String month;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      key: Key('category-${row.category}'),
      onTap: () => openCategory(context, row.category, month),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text('$rank. ${row.category}', style: theme.textTheme.titleSmall)),
                Text(formatCompactMinor(row.totalMinor), style: theme.textTheme.titleSmall),
                const Icon(Icons.chevron_right, size: 18),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: LinearProgressIndicator(
                value: shareOfBiggest.clamp(0, 1),
                minHeight: 8,
                color: ledgerBlue,
                backgroundColor: theme.colorScheme.surfaceContainerHighest,
              ),
            ),
            const SizedBox(height: 4),
            Text('${percentFromBp(row.shareBp)}% of Out', style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

void openAllCategories(BuildContext context, MonthOverview overview, String month) {
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AllCategoriesScreen(overview: overview, month: month)));
}

class AllCategoriesScreen extends StatelessWidget {
  const AllCategoriesScreen({super.key, required this.overview, required this.month});

  final MonthOverview overview;
  final String month;

  @override
  Widget build(BuildContext context) {
    final biggest = overview.categories.isEmpty
        ? BigInt.one
        : overview.categories.map((c) => BigInt.tryParse(c.totalMinor) ?? BigInt.zero).fold<BigInt>(BigInt.zero, (a, b) => a > b ? a : b);
    final denom = biggest > BigInt.zero ? biggest : BigInt.one;
    return Scaffold(
      appBar: AppBar(title: Text('Categories · ${overview.periodLabel}')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (var i = 0; i < overview.categories.length; i++)
            WhereItWentRow(
              rank: i + 1,
              row: overview.categories[i],
              shareOfBiggest: denom == BigInt.zero ? 0 : (BigInt.tryParse(overview.categories[i].totalMinor) ?? BigInt.zero).toDouble() / denom.toDouble(),
              month: month,
            ),
        ],
      ),
    );
  }
}
