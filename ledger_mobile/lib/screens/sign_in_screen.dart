import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/ledger_controller.dart';
import '../widgets/common.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  bool _create = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _email.text.trim();
    final password = _password.text;
    if (!email.contains('@') || email.length > 254) {
      setState(() => _error = 'Enter a valid email.');
      return;
    }
    if (password.length < 8) {
      setState(() => _error = 'Password must be at least 8 characters.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await context.read<LedgerController>().signIn(
      email: email,
      password: password,
      name: _name.text,
      createAccount: _create,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final server = context.watch<LedgerController>().serverUrl ?? '';
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(_create ? 'Create account' : 'Sign in', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 8),
            Text(server, style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 24),
            if (_create) ...[
              TextField(
                key: const Key('name'),
                controller: _name,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(labelText: 'Name'),
              ),
              const SizedBox(height: 12),
            ],
            TextField(
              key: const Key('email'),
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              decoration: const InputDecoration(labelText: 'Email'),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('password'),
              controller: _password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password'),
              onSubmitted: (_) => _busy ? null : _submit(),
            ),
            const SizedBox(height: 16),
            ErrorText(_error),
            FilledButton(
              key: const Key('submit-auth'),
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Please wait…' : (_create ? 'Create account' : 'Sign in')),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _busy
                  ? null
                  : () => setState(() {
                      _create = !_create;
                      _error = null;
                    }),
              child: Text(_create ? 'Already have an account? Sign in' : 'New here? Create an account'),
            ),
          ],
        ),
      ),
    );
  }
}
