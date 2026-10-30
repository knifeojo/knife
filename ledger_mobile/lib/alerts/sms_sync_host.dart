import 'dart:async';

import 'package:flutter/material.dart';

import 'sms_controller.dart';

/// Flushes the SMS queue on launch and whenever the app returns to the foreground,
/// and asks once per new financial sender.
class SmsSyncHost extends StatefulWidget {
  const SmsSyncHost({super.key, required this.child});

  final Widget child;

  @override
  State<SmsSyncHost> createState() => _SmsSyncHostState();
}

class _SmsSyncHostState extends State<SmsSyncHost> with WidgetsBindingObserver {
  var _prompting = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_sync());
  }

  Future<void> _sync() async {
    final sms = SmsAlertScope.maybeOf(context);
    if (!mounted || sms == null) return;
    await sms.refresh();
    if (mounted) await _maybePrompt();
  }

  Future<void> _maybePrompt() async {
    if (_prompting || !mounted) return;
    final sms = SmsAlertScope.maybeOf(context);
    if (sms == null || sms.pendingSenders.isEmpty) return;
    final sender = sms.pendingSenders.first;
    _prompting = true;
    final yes = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Text('Track texts from $sender?'),
        content: Text(
          'These look like account alerts. Only financial texts from $sender will be uploaded. Personal chats, OTPs and promos stay on this phone.',
        ),
        actions: [
          TextButton(
            key: const Key('sms-track-no'),
            onPressed: () => Navigator.pop(context, false),
            child: const Text('No'),
          ),
          FilledButton(
            key: const Key('sms-track-yes'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Yes'),
          ),
        ],
      ),
    );
    _prompting = false;
    if (!mounted) return;
    if (yes == true) {
      await sms.approveSender(sender);
    } else if (yes == false) {
      await sms.denySender(sender);
    }
    if (mounted) await _maybePrompt();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
