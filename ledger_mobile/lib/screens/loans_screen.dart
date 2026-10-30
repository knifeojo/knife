import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

/// Opens the add form. With [lender], it is picked already ("Add your balance" from Afford).
Future<bool> openLoanForm(BuildContext context, {LedgerLoan? loan, String? lender, List<String>? lenders}) async {
  final saved = await Navigator.of(context).push<bool>(
    MaterialPageRoute(
      builder: (_) => LoanFormScreen(loan: loan, lender: lender, lenders: lenders),
    ),
  );
  return saved == true;
}

void openLoans(BuildContext context) {
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LoansScreen()));
}

/// Loans the user typed in from their loan apps. Bank statements show repayments, never the balance left.
class LoansScreen extends StatefulWidget {
  const LoansScreen({super.key});

  @override
  State<LoansScreen> createState() => _LoansScreenState();
}

class _LoansScreenState extends State<LoansScreen> {
  LoanList? _list;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final list = await context.read<LedgerController>().loans();
      if (!mounted) return;
      setState(() {
        _list = list;
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

  Future<void> _edit({LedgerLoan? loan}) async {
    if (await openLoanForm(context, loan: loan, lenders: _list?.lenders)) await _load();
  }

  Future<void> _setStatus(LedgerLoan loan, String status) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await context.read<LedgerController>().setLoanStatus(loan.id, status);
      messenger.showSnackBar(SnackBar(content: Text(status == 'closed' ? '${loan.lender} closed as paid off.' : '${loan.lender} reopened.')));
      await _load();
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = _list;
    return Scaffold(
      appBar: AppBar(title: const Text('Loans')),
      floatingActionButton: list == null
          ? null
          : FloatingActionButton.extended(key: const Key('add-loan'), onPressed: () => _edit(), icon: const Icon(Icons.add), label: const Text('Add loan')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 88),
          children: [
            if (_loading) const Center(child: Text('Loading…')),
            ErrorText(_error),
            if (list != null && !_loading)
              LoanListView(
                list: list,
                onEdit: (loan) => _edit(loan: loan),
                onSetStatus: _setStatus,
              ),
          ],
        ),
      ),
    );
  }
}

class LoanListView extends StatelessWidget {
  const LoanListView({super.key, required this.list, this.onEdit, this.onSetStatus});

  final LoanList list;
  final void Function(LedgerLoan loan)? onEdit;
  final void Function(LedgerLoan loan, String status)? onSetStatus;

  @override
  Widget build(BuildContext context) {
    final open = list.loans.where((l) => l.isOpen).toList();
    final closed = list.loans.where((l) => !l.isOpen).toList();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Copy the balance from your loan app. Can I afford it? then uses the real figure and stops counting the instalment after the last payment.'),
        const SizedBox(height: 12),
        if (open.isEmpty) const EmptyNote('No open loans. Tap Add loan to enter one.'),
        for (final loan in open) _LoanCard(loan: loan, onEdit: onEdit, onSetStatus: onSetStatus),
        if (closed.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Closed', style: theme.textTheme.titleMedium),
          for (final loan in closed)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(loan.lender),
              subtitle: loan.closedAt == null ? null : Text('Closed ${formatDay(loan.closedAt!)}'),
              trailing: TextButton(onPressed: onSetStatus == null ? null : () => onSetStatus!(loan, 'open'), child: const Text('Reopen')),
            ),
        ],
      ],
    );
  }
}

class _LoanCard extends StatelessWidget {
  const _LoanCard({required this.loan, this.onEdit, this.onSetStatus});

  final LedgerLoan loan;
  final void Function(LedgerLoan loan)? onEdit;
  final void Function(LedgerLoan loan, String status)? onSetStatus;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final facts = [
      if (loan.instalmentMinor != null) '${formatMinor(loan.instalmentMinor)} a month',
      if (loan.instalmentsPaid != null && loan.instalmentsTotal != null) '${loan.instalmentsPaid} of ${loan.instalmentsTotal} paid',
      if (loan.nextDueDate != null) 'next due ${formatCalendarDay(loan.nextDueDate!)}',
      if (loan.payoffDate != null) 'last payment ${formatCalendarDay(loan.payoffDate!)}',
    ];
    return Card(
      key: Key('loan-${loan.id}'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(loan.lender, style: theme.textTheme.titleMedium)),
                Text(
                  loan.lastUpdateAt == null
                      ? 'Entered ${formatDay(loan.balanceAsOf)}'
                      : 'Entered ${formatDay(loan.balanceAsOf)} · Last update ${formatDay(loan.lastUpdateAt!)}',
                  key: Key('loan-last-update-${loan.id}'),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text('${formatMinor(loan.outstandingMinor)} left', style: theme.textTheme.headlineSmall?.copyWith(color: scheme.primary)),
            if (facts.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(facts.join(' · '))),
            if (loan.notes != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(loan.notes!, style: theme.textTheme.bodySmall),
              ),
            if (loan.repaymentsSince > 0)
              Container(
                margin: const EdgeInsets.only(top: 10),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: scheme.primary.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(8)),
                child: Text(
                  'Out of date: your bank shows ${formatMinor(loan.repaidSinceMinor)} repaid to ${loan.lender} since you entered this. Edit it from your loan app.',
                ),
              ),
            const SizedBox(height: 8),
            Row(
              children: [
                TextButton(key: Key('edit-loan-${loan.id}'), onPressed: onEdit == null ? null : () => onEdit!(loan), child: const Text('Edit')),
                TextButton(onPressed: onSetStatus == null ? null : () => onSetStatus!(loan, 'closed'), child: const Text('Close: paid off')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Add or edit a loan. Amounts as people type them ("1.5m", "250,000"), days as YYYY-MM-DD or from the calendar.
class LoanFormScreen extends StatefulWidget {
  const LoanFormScreen({super.key, this.loan, this.lender, this.lenders});

  final LedgerLoan? loan;
  final String? lender;
  final List<String>? lenders;

  @override
  State<LoanFormScreen> createState() => _LoanFormScreenState();
}

class _LoanFormScreenState extends State<LoanFormScreen> {
  late final _outstanding = TextEditingController(text: _naira(widget.loan?.outstandingMinor));
  late final _instalment = TextEditingController(text: _naira(widget.loan?.instalmentMinor));
  late final _paid = TextEditingController(text: widget.loan?.instalmentsPaid?.toString() ?? '');
  late final _total = TextEditingController(text: widget.loan?.instalmentsTotal?.toString() ?? '');
  late final _nextDue = TextEditingController(text: _day(widget.loan?.nextDueDate));
  late final _endDate = TextEditingController(text: _day(widget.loan?.endDate));
  late final _notes = TextEditingController(text: widget.loan?.notes ?? '');
  List<String>? _lenders;
  String? _lender;
  String? _error;
  bool _saving = false;

  static String _day(DateTime? d) => d == null ? '' : calendarDayIso(d);

  /// "127584691" -> "1275846.91", which [parseNairaToMinor] reads back exactly.
  static String _naira(String? minor) {
    if (minor == null) return '';
    final v = BigInt.parse(minor);
    final cents = (v % BigInt.from(100)).toInt();
    return '${v ~/ BigInt.from(100)}${cents == 0 ? '' : '.${cents.toString().padLeft(2, '0')}'}';
  }

  @override
  void initState() {
    super.initState();
    _lender = widget.loan?.lender ?? widget.lender;
    _lenders = widget.lenders;
    if (_lenders == null) _loadLenders();
  }

  Future<void> _loadLenders() async {
    try {
      final list = await context.read<LedgerController>().loans();
      if (mounted) setState(() => _lenders = list.lenders);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  @override
  void dispose() {
    for (final c in [_outstanding, _instalment, _paid, _total, _nextDue, _endDate, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickDay(TextEditingController field) async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: parseCalendarDay(field.text)?.toLocal() ?? now,
      firstDate: DateTime(now.year - 5),
      lastDate: DateTime(now.year + 10),
    );
    if (picked != null) field.text = calendarDayIso(DateTime.utc(picked.year, picked.month, picked.day));
  }

  LoanDraft? _draft() {
    final lender = _lender;
    if (lender == null) return _fail('Pick the lender.');
    final balance = _outstanding.text.trim();
    final outstanding = RegExp(r'^[₦n]?\s*0+(\.0+)?$', caseSensitive: false).hasMatch(balance) ? '0' : parseNairaToMinor(balance);
    if (outstanding == null) return _fail('Enter the balance left from your loan app, like 1,250,000.');
    final instalment = _instalment.text.trim().isEmpty ? null : parseNairaToMinor(_instalment.text);
    if (instalment == null && _instalment.text.trim().isNotEmpty) return _fail('Enter the monthly instalment, like 120,000, or leave it empty.');
    int? count(TextEditingController c) => c.text.trim().isEmpty ? null : int.tryParse(c.text.trim()) ?? -1;
    final paid = count(_paid), total = count(_total);
    if ((paid ?? 0) < 0 || (total ?? 1) < 1) return _fail('Instalments must be whole numbers, like 3 of 6.');
    if (paid != null && total != null && paid > total) return _fail('Instalments paid cannot be more than the total.');
    String? day(TextEditingController c) => c.text.trim().isEmpty
        ? null
        : parseCalendarDay(c.text) == null
        ? '!'
        : c.text.trim();
    final next = day(_nextDue), end = day(_endDate);
    if (next == '!' || end == '!') return _fail('Enter dates as YYYY-MM-DD, or pick them from the calendar.');
    final notes = _notes.text.trim();
    return LoanDraft(
      lender: lender,
      outstandingMinor: outstanding,
      instalmentMinor: instalment,
      instalmentsPaid: paid,
      instalmentsTotal: total,
      nextDueDate: next,
      endDate: end,
      notes: notes.isEmpty ? null : notes,
    );
  }

  LoanDraft? _fail(String message) {
    setState(() => _error = message);
    return null;
  }

  Future<void> _save() async {
    final draft = _draft();
    if (draft == null) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      await context.read<LedgerController>().saveLoan(draft, id: widget.loan?.id);
      navigator.pop(true);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _saving = false;
      });
    }
  }

  Widget _dayField(Key key, TextEditingController c, String label, {String? helper}) {
    return TextField(
      key: key,
      controller: c,
      keyboardType: TextInputType.datetime,
      decoration: InputDecoration(
        labelText: label,
        hintText: 'YYYY-MM-DD',
        helperText: helper,
        suffixIcon: IconButton(tooltip: 'Pick a date', icon: const Icon(Icons.calendar_today_outlined), onPressed: () => _pickDay(c)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lenders = _lenders;
    final options = [...?lenders, if (_lender != null && lenders != null && !lenders.contains(_lender)) _lender!];
    return Scaffold(
      appBar: AppBar(title: Text(widget.loan == null ? 'Add a loan' : 'Edit ${widget.loan!.lender}')),
      body: ListView(
        key: const Key('loan-form'),
        padding: const EdgeInsets.all(16),
        children: [
          if (lenders == null && _error == null) const Text('Loading lenders…'),
          if (lenders != null)
            DropdownButtonFormField<String>(
              key: const Key('loan-lender'),
              initialValue: options.contains(_lender) ? _lender : null,
              decoration: const InputDecoration(labelText: 'Lender'),
              items: [for (final l in options) DropdownMenuItem(value: l, child: Text(l))],
              onChanged: (v) => setState(() => _lender = v),
            ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('loan-outstanding'),
            controller: _outstanding,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Balance left', prefixText: '₦ ', helperText: 'As your loan app shows it today'),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('loan-instalment'),
            controller: _instalment,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Monthly instalment (optional)', prefixText: '₦ '),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: const Key('loan-paid'),
                  controller: _paid,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Instalments paid'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  key: const Key('loan-total'),
                  controller: _total,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Out of'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _dayField(const Key('loan-next-due'), _nextDue, 'Next payment due'),
          const SizedBox(height: 12),
          _dayField(const Key('loan-end-date'), _endDate, 'Last payment due', helper: 'Leave empty to work it out from the instalments left'),
          const SizedBox(height: 12),
          TextField(
            key: const Key('loan-notes'),
            controller: _notes,
            maxLength: 300,
            decoration: const InputDecoration(labelText: 'Notes (optional)'),
          ),
          const SizedBox(height: 8),
          ErrorText(_error),
          FilledButton(
            key: const Key('save-loan'),
            onPressed: _saving || lenders == null ? null : _save,
            child: Text(
              _saving
                  ? 'Saving…'
                  : widget.loan == null
                  ? 'Add loan'
                  : 'Save',
            ),
          ),
        ],
      ),
    );
  }
}
