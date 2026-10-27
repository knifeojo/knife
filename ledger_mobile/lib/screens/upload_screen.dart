import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';
import 'top_people_screen.dart';

class UploadScreen extends StatefulWidget {
  const UploadScreen({super.key});

  @override
  State<UploadScreen> createState() => _UploadScreenState();
}

class _UploadScreenState extends State<UploadScreen> {
  final _password = TextEditingController();
  String? _filename;
  Uint8List? _bytes;
  bool _busy = false;
  String? _error;
  List<StatementFileResult>? _results;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    setState(() => _error = null);
    final file = await FilePicker.pickFile(
      type: FileType.custom,
      allowedExtensions: const ['pdf', 'csv', 'xlsx', 'txt'],
    );
    if (file == null) return;
    final Uint8List bytes;
    try {
      bytes = await file.readAsBytes();
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Could not read that file.');
      return;
    }
    if (!mounted) return;
    if (bytes.length > 5 * 1024 * 1024) {
      setState(() => _error = 'File is larger than 5 MB.');
      return;
    }
    setState(() {
      _filename = file.name;
      _bytes = bytes;
      _results = null;
    });
  }

  Future<void> _upload() async {
    final bytes = _bytes;
    final filename = _filename;
    if (bytes == null || filename == null) {
      setState(() => _error = 'Choose a PDF or CSV statement first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final controller = context.read<LedgerController>();
      final results = await controller.upload(filename: filename, bytes: bytes, password: _password.text);
      if (!mounted) return;
      setState(() {
        _results = results;
        _busy = false;
        _password.clear();
      });
      final created = results.fold<int>(0, (n, r) => n + (r.ok?.created ?? 0));
      if (created > 0) {
        try {
          final state = await controller.onboarding();
          if (mounted && state.showTopPeople) {
            await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => TopPeopleScreen(initial: state)));
          }
        } on ApiException {
          // Older servers skip the picker.
        }
      }
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final results = _results;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Upload a statement', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        const Text('Pick a GTBank, Pesa, Deel, or other PDF or CSV export. It is parsed on your server and not kept in the app. A PDF password is used once to open the file and is not stored.'),
        const SizedBox(height: 16),
        OutlinedButton(onPressed: _busy ? null : _pick, child: const Text('Choose PDF or CSV')),
        if (_filename != null) ...[const SizedBox(height: 8), Text(_filename!)],
        const SizedBox(height: 12),
        TextField(
          controller: _password,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'PDF password, if the file has one'),
        ),
        const SizedBox(height: 16),
        ErrorText(_error),
        FilledButton(onPressed: _busy ? null : _upload, child: Text(_busy ? 'Uploading…' : 'Upload')),
        if (results != null) ...[
          const SizedBox(height: 16),
          for (final result in results) ListTile(contentPadding: EdgeInsets.zero, title: Text(result.describe())),
          const Text('Open Accounts or Activity and pull down to refresh.'),
        ],
      ],
    );
  }
}
