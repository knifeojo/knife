import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../ask/message.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

const askChips = [
  'Can I afford...?',
  'Where did my money go this month?',
  'What did clearing my loans free up?',
  'How much is left until payday?',
];

class AskScreen extends StatefulWidget {
  const AskScreen({super.key});

  @override
  State<AskScreen> createState() => _AskScreenState();
}

class _AskScreenState extends State<AskScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  List<AskMessage> _messages = const [];
  String? _error;
  var _sending = false;
  var _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final rows = await context.read<LedgerController>().askHistory();
      if (!mounted) return;
      setState(() {
        _messages = rows;
        _loaded = true;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _loaded = true;
        _error = error.message;
      });
    }
  }

  Future<void> _send(String raw) async {
    final question = raw.trim();
    if (question.isEmpty || _sending) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _sending = true;
      _error = null;
      _messages = [
        ..._messages,
        AskMessage(id: 'local', role: 'user', text: question),
      ];
    });
    _input.clear();
    _jump();
    try {
      final reply = await context.read<LedgerController>().ask(question);
      if (!mounted) return;
      setState(() {
        _messages = [
          ..._messages.where((message) => message.id != 'local'),
          AskMessage(id: 'sent', role: 'user', text: question),
          reply,
        ];
        _sending = false;
      });
      _jump();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = error.message;
      });
    }
  }

  void _jump() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(_scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Expanded(
          child: ListView(
            key: const Key('ask-list'),
            controller: _scroll,
            padding: const EdgeInsets.all(16),
            children: [
              Text('Ask Ledger', style: theme.textTheme.headlineSmall),
              const SizedBox(height: 6),
              const Text('A chat with your ledger. Prices go through the affordability check. Figures come from your own data.'),
              const SizedBox(height: 12),
              if (!_loaded) const LinearProgressIndicator(),
              ErrorText(_error),
              for (final message in _messages) _Bubble(message: message),
              if (_sending) const Padding(padding: EdgeInsets.only(top: 8), child: Text('Checking your ledger…')),
              if (_messages.isEmpty && _loaded) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final chip in askChips)
                      ActionChip(
                        key: Key('ask-chip-$chip'),
                        label: Text(chip),
                        onPressed: _sending ? null : () => _send(chip),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('ask-input'),
                    controller: _input,
                    textInputAction: TextInputAction.send,
                    decoration: const InputDecoration(hintText: 'Ask about your money'),
                    onSubmitted: _send,
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  key: const Key('ask-send'),
                  onPressed: _sending ? null : () => _send(_input.text),
                  icon: const Icon(Icons.send),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});

  final AskMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mine = message.fromUser;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 520),
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: mine ? theme.colorScheme.primaryContainer : theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(message.text),
            if (message.affordability != null) AskAffordCard(result: message.affordability!, keepAtLeastMinor: message.keepAtLeastMinor, freedLoans: message.freedLoans),
            if (message.affordability == null && message.freedLoans.isNotEmpty) AskFreedCard(loans: message.freedLoans),
          ],
        ),
      ),
    );
  }
}

class AskAffordCard extends StatelessWidget {
  const AskAffordCard({super.key, required this.result, this.keepAtLeastMinor, this.freedLoans = const []});

  final AffordabilityCheck result;
  final String? keepAtLeastMinor;
  final List<AskFreedLoan> freedLoans;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final keep = keepAtLeastMinor ?? result.lowestMinor;
    final label = switch (result.verdict) {
      'yes' => 'Yes',
      'stretch' => 'Stretch',
      _ => 'No',
    };
    return Card(
      key: const Key('ask-afford-card'),
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('Keep at least ${formatMinor(keep)}'),
            Text('Safety buffer ${formatMinor(result.bufferMinor)}'),
            const SizedBox(height: 8),
            Text('Obligations', style: theme.textTheme.labelLarge),
            if (result.obligations.isEmpty) const Text('No monthly bills on file.'),
            for (final item in result.obligations) Text('${item.name}: ${formatMinor(item.monthlyMinor)} a month'),
            const SizedBox(height: 8),
            AskFreedCard(loans: freedLoans),
          ],
        ),
      ),
    );
  }
}

class AskFreedCard extends StatelessWidget {
  const AskFreedCard({super.key, this.loans = const [], this.titled = true});

  final List<AskFreedLoan> loans;
  final bool titled;

  @override
  Widget build(BuildContext context) {
    if (!titled && loans.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (titled) Text('Freed loans', style: Theme.of(context).textTheme.labelLarge),
        if (loans.isEmpty) const Text('No cleared loan is freeing a monthly amount.'),
        for (final loan in loans) Text('${loan.lender}: ${formatMinor(loan.freedPerMonthMinor)} a month'),
      ],
    );
  }
}
