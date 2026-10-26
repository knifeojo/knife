import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/ledger_controller.dart';
import '../widgets/common.dart';

/// Opens Your people. Resolves to true when anything changed, so the caller can reload.
Future<bool> openPeople(BuildContext context) async {
  final changed = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const PeopleScreen()));
  return changed == true;
}

/// "Your people": who the names in your statements are, what their payments are labelled, and
/// how much moves each month. The same list as the web page.
class PeopleScreen extends StatefulWidget {
  const PeopleScreen({super.key});

  @override
  State<PeopleScreen> createState() => _PeopleScreenState();
}

class _PeopleScreenState extends State<PeopleScreen> {
  PeopleList? _list;
  String? _error;
  bool _busy = false;
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await context.read<LedgerController>().people();
      if (!mounted) return;
      setState(() {
        _list = list;
        _error = null;
      });
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  /// Runs one change and shows how many payments it relabelled.
  Future<void> _write(Future<PeopleList> Function(LedgerController c) call, String done) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final controller = context.read<LedgerController>();
    try {
      final list = (await call(controller)).withChoicesFrom(_list);
      _changed = true;
      if (!mounted) return;
      setState(() => _list = list);
      final unread = list.unread.isEmpty ? '' : ' Could not read: ${list.unread.join('; ')}.';
      messenger.showSnackBar(SnackBar(content: Text('$done$unread')));
    } on ApiException catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addText() async {
    final text = await showDialog<String>(context: context, builder: (_) => const _AddPeopleDialog());
    if (text == null || text.trim().isEmpty) return;
    await _write((c) => c.addPeopleText(text), 'Saved. Their payments are relabelled.');
  }

  Future<void> _relationship(Person p) async {
    final choices = _list?.relationships ?? const <RelationshipChoice>[];
    final value = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: Text('Who is ${p.displayName} to you?'),
        children: [
          for (final r in choices)
            SimpleDialogOption(
              key: Key('choose-${r.value}'),
              onPressed: () => Navigator.of(context).pop(r.value),
              child: Text(r.value == p.relationship ? '${r.label} (now)' : r.label),
            ),
        ],
      ),
    );
    if (value == null || value == p.relationship) return;
    await _write((c) => c.updatePerson(p.id, relationship: value), 'Updated ${p.displayName}.');
  }

  Future<void> _addAlias(Person p) async {
    final alias = await showDialog<String>(
      context: context,
      builder: (_) => _AliasDialog(person: p),
    );
    if (alias == null || alias.trim().isEmpty) return;
    await _write((c) => c.updatePerson(p.id, addAliases: [alias.trim()]), 'Added "${alias.trim()}" to ${p.displayName}.');
  }

  Future<void> _aliasAction(Person p, PersonAlias a) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(title: Text(a.name), subtitle: Text(a.rejected ? 'Marked as someone else' : 'A spelling of ${p.displayName}')),
            if (!a.rejected)
              ListTile(
                key: const Key('alias-reject'),
                leading: const Icon(Icons.person_off_outlined),
                title: const Text('This is someone else'),
                onTap: () => Navigator.of(context).pop('reject'),
              ),
            ListTile(
              key: const Key('alias-remove'),
              leading: const Icon(Icons.delete_outline),
              title: const Text('Remove this spelling'),
              onTap: () => Navigator.of(context).pop('remove'),
            ),
          ],
        ),
      ),
    );
    if (action == 'reject') await _write((c) => c.updatePerson(p.id, rejectAliases: [a.name]), '"${a.name}" is no longer ${p.displayName}.');
    if (action == 'remove') await _write((c) => c.updatePerson(p.id, removeAliases: [a.name]), 'Removed "${a.name}".');
  }

  Future<void> _merge(Person p) async {
    final others = (_list?.people ?? const <Person>[]).where((o) => o.id != p.id).toList();
    final source = await showDialog<Person>(
      context: context,
      builder: (context) => SimpleDialog(
        title: Text('Who is the same person as ${p.displayName}?'),
        children: [
          for (final o in others)
            SimpleDialogOption(
              key: Key('merge-into-${o.id}'),
              onPressed: () => Navigator.of(context).pop(o),
              child: Text('${o.displayName} · ${o.relationshipLabel}'),
            ),
        ],
      ),
    );
    if (source == null) return;
    await _write((c) => c.mergePeople(targetId: p.id, sourceId: source.id), 'Merged ${source.displayName} into ${p.displayName}.');
  }

  Future<void> _delete(Person p) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove ${p.displayName}?'),
        content: const Text('Their payments go back to the normal rules. You can undo this.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(key: const Key('delete-confirm'), onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok != true) return;
    await _write((c) => c.deletePerson(p.id), 'Removed ${p.displayName}.');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final list = _list;
    return PopScope<bool>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('Your people')),
        floatingActionButton: FloatingActionButton.extended(
          key: const Key('people-add'),
          onPressed: _busy || list == null ? null : _addText,
          icon: const Icon(Icons.person_add_alt),
          label: const Text('Add people'),
        ),
        body: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            key: const Key('people-list'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 88),
            children: [
              Text(
                'Your bank shows names, not relationships. Tell Ledger who people are and every payment to or from them is labelled, '
                'past and future. Family support counts as an obligation in Afford, never as something to cut.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              if (_error != null) ErrorText(_error),
              if (list == null && _error == null) const Text('Loading…'),
              if (list?.undo case final undo?)
                Card(
                  key: const Key('people-undo'),
                  color: theme.colorScheme.secondaryContainer,
                  child: ListTile(
                    title: Text(undo.label),
                    subtitle: Text('${undo.changed} payment${undo.changed == 1 ? '' : 's'} changed'),
                    trailing: TextButton(
                      key: const Key('people-undo-button'),
                      onPressed: _busy ? null : () => _write((c) => c.undoPeople(batchId: undo.batchId), 'Undone.'),
                      child: const Text('Undo'),
                    ),
                  ),
                ),
              if (list != null && list.people.isEmpty)
                const EmptyNote('No people yet. Tap Add people and write "My wife is Gift Ojo", one per line, or answer the people questions in Review.'),
              if (list != null)
                for (final p in list.people)
                  PersonCard(
                    key: Key('person-${p.id}'),
                    person: p,
                    busy: _busy,
                    canMerge: list.people.length > 1,
                    onRelationship: () => _relationship(p),
                    onAddAlias: () => _addAlias(p),
                    onAlias: (a) => _aliasAction(p, a),
                    onMerge: () => _merge(p),
                    onDelete: () => _delete(p),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class PersonCard extends StatelessWidget {
  const PersonCard({
    super.key,
    required this.person,
    required this.busy,
    required this.canMerge,
    required this.onRelationship,
    required this.onAddAlias,
    required this.onAlias,
    required this.onMerge,
    required this.onDelete,
  });

  final Person person;
  final bool busy;
  final bool canMerge;
  final VoidCallback onRelationship;
  final VoidCallback onAddAlias;
  final void Function(PersonAlias alias) onAlias;
  final VoidCallback onMerge;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final p = person;
    final totals = [
      if (p.outMinor != '0') 'Paid ${formatMinor(p.outMinor)}',
      if (p.inMinor != '0') 'Received ${formatMinor(p.inMinor)}',
      '${p.count} payment${p.count == 1 ? '' : 's'}',
      if (p.lastDate != null) 'last ${p.lastDate}',
    ].join(' · ');
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(p.displayName, style: theme.textTheme.titleMedium)),
                ActionChip(
                  key: Key('relationship-${p.id}'),
                  label: Text(p.relationshipLabel),
                  tooltip: 'Change relationship',
                  onPressed: busy ? null : onRelationship,
                ),
              ],
            ),
            if (p.label != null) Text('Labelled ${p.label}', style: theme.textTheme.bodySmall),
            if (p.note != null && p.note!.isNotEmpty) Text(p.note!, style: theme.textTheme.bodySmall),
            const SizedBox(height: 4),
            Text(totals, style: theme.textTheme.bodySmall),
            if (p.months.any((m) => m.inMinor != '0' || m.outMinor != '0')) ...[
              const SizedBox(height: 8),
              Table(
                key: Key('months-${p.id}'),
                columnWidths: const {0: FlexColumnWidth(1.2), 1: FlexColumnWidth(), 2: FlexColumnWidth()},
                children: [
                  TableRow(
                    children: [
                      Text('Month', style: theme.textTheme.labelSmall),
                      Text('Paid', style: theme.textTheme.labelSmall, textAlign: TextAlign.right),
                      Text('Received', style: theme.textTheme.labelSmall, textAlign: TextAlign.right),
                    ],
                  ),
                  for (final m in p.months)
                    TableRow(
                      children: [
                        Text(m.month, style: theme.textTheme.bodySmall),
                        Text(m.outMinor == '0' ? '—' : formatMinor(m.outMinor), style: theme.textTheme.bodySmall, textAlign: TextAlign.right),
                        Text(m.inMinor == '0' ? '—' : formatMinor(m.inMinor), style: theme.textTheme.bodySmall, textAlign: TextAlign.right),
                      ],
                    ),
                ],
              ),
            ],
            const SizedBox(height: 8),
            Text('As your bank writes it', style: theme.textTheme.labelSmall),
            const SizedBox(height: 4),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                for (final a in p.aliases)
                  InputChip(
                    key: Key('alias-${p.id}-${a.name}'),
                    label: Text(
                      a.rejected ? '${a.name} (someone else)' : a.name,
                      style: a.rejected ? const TextStyle(decoration: TextDecoration.lineThrough) : null,
                    ),
                    onPressed: busy ? null : () => onAlias(a),
                  ),
                ActionChip(
                  key: Key('alias-add-${p.id}'),
                  avatar: const Icon(Icons.add, size: 16),
                  label: const Text('Spelling'),
                  onPressed: busy ? null : onAddAlias,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Wrap(
              alignment: WrapAlignment.end,
              children: [
                if (canMerge) TextButton(key: Key('merge-${p.id}'), onPressed: busy ? null : onMerge, child: const Text('Merge duplicate')),
                TextButton(key: Key('delete-${p.id}'), onPressed: busy ? null : onDelete, child: const Text('Remove')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _AddPeopleDialog extends StatefulWidget {
  const _AddPeopleDialog();

  @override
  State<_AddPeopleDialog> createState() => _AddPeopleDialogState();
}

class _AddPeopleDialogState extends State<_AddPeopleDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Who are your people?'),
      content: TextField(
        key: const Key('people-text'),
        controller: _text,
        autofocus: true,
        minLines: 3,
        maxLines: 6,
        maxLength: 2000,
        decoration: const InputDecoration(
          hintText: 'My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo\nMy mum is Bisi Ojo',
          helperText: 'One person per line, the name as your bank writes it.',
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(key: const Key('people-text-save'), onPressed: () => Navigator.of(context).pop(_text.text), child: const Text('Save')),
      ],
    );
  }
}

class _AliasDialog extends StatefulWidget {
  const _AliasDialog({required this.person});

  final Person person;

  @override
  State<_AliasDialog> createState() => _AliasDialogState();
}

class _AliasDialogState extends State<_AliasDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Another spelling of ${widget.person.displayName}'),
      content: TextField(
        key: const Key('alias-text'),
        controller: _text,
        autofocus: true,
        maxLength: 60,
        decoration: const InputDecoration(hintText: 'e.g. OJO GIFT A'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(key: const Key('alias-save'), onPressed: () => Navigator.of(context).pop(_text.text), child: const Text('Save')),
      ],
    );
  }
}
