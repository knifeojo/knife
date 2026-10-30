import 'dart:async';

import 'package:flutter/material.dart';

import '../alerts/senders.dart';
import '../alerts/sms_controller.dart';
import '../alerts/sms_platform.dart';
import '../alerts/source_id.dart';

/// Settings → Bank alerts → SMS bank alerts.
class SmsBankAlertsCard extends StatefulWidget {
  const SmsBankAlertsCard({super.key});

  @override
  State<SmsBankAlertsCard> createState() => _SmsBankAlertsCardState();
}

class _SmsBankAlertsCardState extends State<SmsBankAlertsCard>
    with WidgetsBindingObserver {
  var _working = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_refresh());
  }

  Future<void> _refresh() async {
    final sms = SmsAlertScope.maybeOf(context);
    if (!mounted || sms == null) return;
    await sms.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final sms = SmsAlertScope.maybeOf(context);
    if (sms == null) {
      return _details(
        optIn: false,
        statsLabel: smsLastSyncLabel(null),
        counts: smsCountLabel(captured: 0, sent: 0, queued: 0),
        onChanged: _unavailable,
      );
    }
    return ListenableBuilder(
      listenable: sms,
      builder: (context, _) {
        return _details(
          optIn: sms.optIn,
          statsLabel: smsLastSyncLabel(sms.stats.lastSyncAt),
          counts: smsCountLabel(
            captured: sms.stats.captured,
            sent: sms.stats.sent,
            queued: sms.queued,
          ),
          onChanged: _working
              ? null
              : (value) {
                  if (value) {
                    unawaited(_turnOn(sms));
                  } else {
                    unawaited(_turnOff(sms));
                  }
                },
        );
      },
    );
  }

  Widget _details({
    required bool optIn,
    required String statsLabel,
    required String counts,
    required ValueChanged<bool>? onChanged,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile(
          key: const Key('sms-alerts-toggle'),
          contentPadding: EdgeInsets.zero,
          title: const Text('SMS bank alerts'),
          subtitle: const Text(
            '$smsBankSenderPhrase are tracked automatically. A new account sender asks once. Personal chats, OTPs and promos stay on the phone.',
          ),
          value: optIn,
          onChanged: onChanged,
        ),
        Text(statsLabel, key: const Key('sms-last-sync')),
        const SizedBox(height: 2),
        Text(counts, key: const Key('sms-counts')),
      ],
    );
  }

  Future<void> _unavailable(bool value) async {
    if (!value || !mounted) return;
    final proceed = await _explain();
    if (proceed != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('SMS bank alerts run on the Android app.')),
    );
  }

  Future<void> _turnOff(SmsAlertController sms) async {
    await sms.setOptIn(false);
  }

  Future<void> _turnOn(SmsAlertController sms) async {
    setState(() => _working = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final proceed = await _explain();
      if (proceed != true || !mounted) return;
      var permission = sms.permission;
      if (permission != SmsPermission.permanentlyDenied) {
        permission = await sms.requestPermissions();
      }
      if (!mounted) return;
      if (permission == SmsPermission.unavailable) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text('SMS bank alerts run on the Android app.'),
          ),
        );
        return;
      }
      if (permission == SmsPermission.permanentlyDenied) {
        final open = await _settingsDialog();
        if (open == true) await sms.openAppSettings();
        return;
      }
      if (permission != SmsPermission.granted) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text(
              'SMS permission was not granted. Bank alerts stay off.',
            ),
          ),
        );
        return;
      }
      await sms.setOptIn(true);
      if (!mounted) return;
      if (!sms.backfillOffered) {
        final yes = await _backfillDialog(lookbackLabel(sms.now(), smsSenderBackfillDays));
        if (!mounted) return;
        if (yes == true) {
          try {
            final count = await sms.importThisMonth();
            await sms.markBackfillOffered();
            if (!mounted) return;
            final text = count == 0
                ? 'No bank SMS from the last 90 days.'
                : 'Imported $count bank SMS from the last 90 days.';
            messenger.showSnackBar(SnackBar(content: Text(text)));
          } catch (_) {
            if (!mounted) return;
            messenger.showSnackBar(
              const SnackBar(
                content: Text(
                  "Could not read this month's bank SMS. You can try again.",
                ),
              ),
            );
            return;
          }
        } else {
          await sms.markBackfillOffered();
        }
      }
      final result = await sms.flush();
      if (!mounted) return;
      if (!result.ok && result.kept > 0) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text(
              'Bank SMS are saved on this phone and will send when the server is reachable.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<bool?> _explain() {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('SMS bank alerts'),
        content: const Text(
          'Ledger reads account alerts. $smsBankSenderPhrase are tracked automatically. A new sender that looks like a bank or fintech asks once before its texts are uploaded. Personal chats, OTPs and promos never leave this phone. On Android, set Battery to Unrestricted so texts can upload while Ledger is closed.',
        ),
        actions: [
          TextButton(
            key: const Key('sms-explain-cancel'),
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('sms-explain-continue'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
  }

  Future<bool?> _backfillDialog(String since) {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Import recent bank SMS?'),
        content: Text(
          'Read account and loan texts since $since, the last 90 days. $smsBankSenderPhrase upload now. A new sender asks once before its texts leave the phone. Personal chats, OTPs and promos are ignored.',
        ),
        actions: [
          TextButton(
            key: const Key('sms-backfill-no'),
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Not now'),
          ),
          FilledButton(
            key: const Key('sms-backfill-yes'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Import'),
          ),
        ],
      ),
    );
  }

  Future<bool?> _settingsDialog() {
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('SMS permission is blocked'),
        content: const Text(
          "Android will not ask again. Open Ledger's app settings and allow SMS, then turn SMS bank alerts on.",
        ),
        actions: [
          TextButton(
            key: const Key('sms-settings-cancel'),
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Not now'),
          ),
          FilledButton(
            key: const Key('sms-open-settings'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Open app settings'),
          ),
        ],
      ),
    );
  }
}
