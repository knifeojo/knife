import 'package:flutter/material.dart';

class AffordabilityScreen extends StatelessWidget {
  const AffordabilityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text('Can I really afford this?', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 12),
        const Text('This check is not built yet. When it is, it will use the ledger already on your server. It will not guess a number.'),
        const SizedBox(height: 20),
        Text('It will weigh', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        const _Point('Income that actually arrives'),
        const _Point('Fixed obligations: rent, family support, and loan repayments such as FairMoney and Renmoney'),
        const _Point('A buffer you want left untouched'),
        const _Point('Cash flow over the weeks ahead, not just today’s balance'),
      ],
    );
  }
}

class _Point extends StatelessWidget {
  const _Point(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 6, right: 10),
            child: Icon(Icons.circle, size: 8, color: Theme.of(context).colorScheme.primary),
          ),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }
}
