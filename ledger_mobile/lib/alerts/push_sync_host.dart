import 'dart:async';

import 'package:flutter/material.dart';

import 'push_controller.dart';

/// Asks once per new financial app: "Track alerts from App?".
class PushSyncHost extends StatefulWidget {
  const PushSyncHost({super.key, required this.child});

  final Widget child;

  @override
  State<PushSyncHost> createState() => _PushSyncHostState();
}

class _PushSyncHostState extends State<PushSyncHost>
    with WidgetsBindingObserver {
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
    final push = PushAlertScope.maybeOf(context);
    if (!mounted || push == null) return;
    await push.refresh();
    if (mounted) await _maybePrompt();
  }

  Future<void> _maybePrompt() async {
    if (_prompting || !mounted) return;
    final push = PushAlertScope.maybeOf(context);
    if (push == null || push.pending.isEmpty) return;
    final app = push.pending.first;
    _prompting = true;
    final yes = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Text('Track alerts from ${app.label}?'),
        content: Text(
          'These look like account alerts. Only financial alerts from ${app.label} will be uploaded. Chats, OTPs and promos stay on this phone.',
        ),
        actions: [
          TextButton(
            key: const Key('push-track-no'),
            onPressed: () => Navigator.pop(context, false),
            child: const Text('No'),
          ),
          FilledButton(
            key: const Key('push-track-yes'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Yes'),
          ),
        ],
      ),
    );
    _prompting = false;
    if (!mounted) return;
    if (yes == true) {
      await push.approve(app.packageName);
    } else if (yes == false) {
      await push.deny(app.packageName);
    }
    if (mounted) await _maybePrompt();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
