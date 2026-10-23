import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

class AffordabilityScreen extends StatefulWidget {
  const AffordabilityScreen({super.key});

  @override
  State<AffordabilityScreen> createState() => _AffordabilityScreenState();
}

class _AffordabilityScreenState extends State<AffordabilityScreen> {
  final _amount = TextEditingController();
  final _description = TextEditingController();
  String _horizon = 'month_end';
  bool _checking = false;
  String? _error;
  AffordabilityCheck? _result;

  @override
  void dispose() {
    _amount.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    final minor = parseNairaToMinor(_amount.text);
    if (minor == null) {
      setState(() => _error = 'Enter an amount, like 250,000 or 2.5m.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final result = await context.read<LedgerController>().affordability(amountMinor: minor, description: _description.text, horizon: _horizon);
      if (!mounted) return;
      setState(() {
        _result = result;
        _checking = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _checking = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final result = _result;
    return ListView(
      key: const Key('afford-list'),
      padding: const EdgeInsets.all(16),
      children: [
        Text('Can I really afford this?', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 6),
        const Text('Ledger checks a price against your income, fixed bills, a safety buffer and the days ahead.'),
        const SizedBox(height: 16),
        TextField(
          key: const Key('afford-amount'),
          controller: _amount,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(labelText: 'Price', hintText: '2,500,000 or 2.5m', prefixText: '₦ '),
          onSubmitted: (_) => _check(),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('afford-description'),
          controller: _description,
          maxLength: 80,
          decoration: const InputDecoration(labelText: 'What is it? (optional)', hintText: 'A used car'),
        ),
        const SizedBox(height: 4),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'month_end', label: Text('Month end')),
            ButtonSegment(value: '30', label: Text('30 days')),
            ButtonSegment(value: '90', label: Text('90 days')),
          ],
          selected: {_horizon},
          onSelectionChanged: (value) => setState(() => _horizon = value.first),
        ),
        const SizedBox(height: 16),
        FilledButton(key: const Key('afford-check'), onPressed: _checking ? null : _check, child: Text(_checking ? 'Checking…' : 'Check')),
        const SizedBox(height: 16),
        ErrorText(_error),
        if (result != null && !_checking) AffordabilityAnswer(result: result),
      ],
    );
  }
}

class AffordabilityAnswer extends StatelessWidget {
  const AffordabilityAnswer({super.key, required this.result});

  final AffordabilityCheck result;

  static const _bufferRule = {'obligations': 'a month of bills', 'floor': 'minimum', 'yours': 'yours'};
  static const _incomeRule = {'paydays': 'your paydays', 'monthly': 'typical month', 'none': 'none counted'};

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final r = result;
    final (label, background, foreground) = switch (r.verdict) {
      'yes' => ('Yes', scheme.primary, scheme.onPrimary),
      'stretch' => ('Stretch', const Color(0xFFFFF4D6), const Color(0xFF6B4A00)),
      _ => ('No', scheme.error, scheme.onError),
    };
    String money(String minor) => formatMinor(minor);
    String out(String minor) => minor == '0' ? money(minor) : '-${money(minor)}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(999)),
                  child: Text(
                    label,
                    style: theme.textTheme.labelLarge?.copyWith(color: foreground, fontWeight: FontWeight.w600),
                  ),
                ),
                const SizedBox(height: 12),
                Text(r.headline, style: theme.textTheme.bodyLarge),
                for (final line in r.detail)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(line, style: theme.textTheme.bodyMedium),
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        _Section(
          title: 'Your typical month',
          subtitle: r.incomeMonths.isEmpty ? 'No months imported yet' : 'From ${r.incomeMonths.join(', ')}',
          rows: [
            _Line('Income', money(r.monthlyIncomeMinor)),
            _Line('Fixed obligations', out(r.monthlyObligationsMinor)),
            for (final o in r.obligations) _Line('${o.name} · ${o.label ?? o.category}', money(o.monthlyMinor), sub: true),
            if (r.otherLoanRepaymentsMinor != '0') _Line('Other loan repayments', money(r.otherLoanRepaymentsMinor), sub: true),
            _Line('Everyday spending', out(r.monthlyEverydayMinor)),
            _Line('Usual surplus', money(r.monthlySurplusMinor), strong: true),
          ],
        ),
        _Section(
          title: '${formatDay(r.windowFrom)} to ${formatDay(r.windowTo.subtract(const Duration(milliseconds: 1)))}',
          rows: [
            _Line(r.cashKnown ? 'Cash${r.cashAsOf == null ? '' : ', ${formatDay(r.cashAsOf!)}'}' : 'Cash on file (none)', money(r.cashMinor)),
            _Line('Income in (${_incomeRule[r.incomeRule] ?? r.incomeRule})', '+${money(r.incomeInMinor)}'),
            _Line('Fixed obligations due', out(r.obligationsOutMinor)),
            _Line('Everyday spending, estimated', out(r.everydayOutMinor)),
            _Line(r.description == null ? 'This purchase' : 'This purchase (${r.description})', out(r.amountMinor)),
            _Line('Lowest point, ${formatDay(r.lowestOn)}', money(r.lowestMinor), strong: true),
            _Line('Safety buffer (${_bufferRule[r.bufferRule] ?? r.bufferRule})', money(r.bufferMinor)),
            _Line('Room above buffer', money(r.headroomMinor), strong: true),
          ],
        ),
        for (final note in r.notes)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(note, style: theme.textTheme.bodySmall),
          ),
      ],
    );
  }
}

class _Line {
  const _Line(this.label, this.value, {this.strong = false, this.sub = false});

  final String label;
  final String value;
  final bool strong;
  final bool sub;
}

class _Section extends StatelessWidget {
  const _Section({required this.title, this.subtitle, required this.rows});

  final String title;
  final String? subtitle;
  final List<_Line> rows;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title, style: theme.textTheme.titleMedium),
            if (subtitle != null) Text(subtitle!, style: theme.textTheme.bodySmall),
            const SizedBox(height: 8),
            for (final row in rows)
              Padding(
                padding: EdgeInsets.only(top: 4, bottom: 4, left: row.sub ? 12 : 0),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        row.label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: row.sub ? theme.textTheme.bodySmall : theme.textTheme.bodyMedium?.copyWith(fontWeight: row.strong ? FontWeight.w600 : null),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      row.value,
                      style: row.sub ? theme.textTheme.bodySmall : theme.textTheme.bodyMedium?.copyWith(fontWeight: row.strong ? FontWeight.w600 : null),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
