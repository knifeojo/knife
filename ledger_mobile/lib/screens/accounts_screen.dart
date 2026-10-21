import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key});

  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

class _AccountsScreenState extends State<AccountsScreen> {
  AccountList? _accounts;
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
      final accounts = await context.read<LedgerController>().accounts();
      if (!mounted) return;
      setState(() {
        _accounts = accounts;
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
    final accounts = _accounts;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          if (_loading) const Center(child: Text('Loading…')),
          if (_error != null) ErrorText(_error),
          if (accounts != null && !_loading) AccountListView(accounts: accounts),
        ],
      ),
    );
  }
}

class AccountListView extends StatelessWidget {
  const AccountListView({super.key, required this.accounts});

  final AccountList accounts;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        StatTile(label: 'Naira total', minor: accounts.totalBaseMinor, currency: accounts.totalBaseCurrency),
        const SizedBox(height: 12),
        if (accounts.accounts.isEmpty) const EmptyNote('No accounts yet. Upload a bank statement and Ledger will read it on your server.'),
        for (final account in accounts.accounts)
          Card(
            child: ListTile(
              title: Text(account.accountName),
              subtitle: Text('${account.institution} · ${account.maskedAccountNumber}'),
              trailing: Text(formatMinor(account.balanceMinor, currency: account.currency)),
            ),
          ),
      ],
    );
  }
}
