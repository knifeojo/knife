import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import 'transactions_screen.dart';

void openIncomeSources(BuildContext context, MonthOverview overview, String month) {
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => IncomeSourcesScreen(overview: overview, month: month)));
}

class IncomeSourcesScreen extends StatelessWidget {
  const IncomeSourcesScreen({super.key, required this.overview, required this.month});

  final MonthOverview overview;
  final String month;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Income · ${overview.periodLabel}')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(formatMinor(overview.inMinor), style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 4),
          Text('By source this month', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          if (overview.incomeSources.isEmpty) const Text('No income recorded this month.'),
          for (final source in overview.incomeSources)
            ListTile(
              key: Key('income-source-${source.name}'),
              contentPadding: EdgeInsets.zero,
              title: Text(source.name),
              subtitle: Text('${source.kind} · ${source.count} payment${source.count == 1 ? '' : 's'}'),
              trailing: Text(formatCompactMinor(source.totalMinor)),
              onTap: () => openTransactions(
                context,
                TransactionQuery(
                  title: source.name,
                  payee: source.name,
                  type: 'CREDIT',
                  month: month,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
