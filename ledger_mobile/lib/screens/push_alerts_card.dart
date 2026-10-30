import 'dart:async';

import 'package:flutter/material.dart';

import '../alerts/push_controller.dart';
import '../alerts/push_platform.dart';

/// Settings and onboarding card that opens the system notification-listener screen.
class PushAlertsCard extends StatefulWidget {
  const PushAlertsCard({super.key});

  @override
  State<PushAlertsCard> createState() => _PushAlertsCardState();
}

class _PushAlertsCardState extends State<PushAlertsCard>
    with WidgetsBindingObserver {
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
    final push = PushAlertScope.maybeOf(context);
    if (!mounted || push == null) return;
    await push.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final push = PushAlertScope.maybeOf(context);
    if (push == null) return _body(enabled: false, onAllow: _unavailable);
    return ListenableBuilder(
      listenable: push,
      builder: (context, _) {
        return _body(
          enabled: push.enabled,
          onAllow: push.enabled ? null : () => _open(push),
        );
      },
    );
  }

  Widget _body({required bool enabled, required VoidCallback? onAllow}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('App alerts', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 4),
        const Text(
          'Ledger can read bank app notifications on this phone. Messaging, social and telco apps are ignored. A new bank app asks once. Other alerts never leave the phone.',
        ),
        const SizedBox(height: 8),
        if (enabled)
          const Text(
            'Notification access is on.',
            key: Key('push-access-on'),
          )
        else
          FilledButton(
            key: const Key('push-open-settings'),
            onPressed: onAllow,
            child: const Text('Allow notification access'),
          ),
      ],
    );
  }

  Future<void> _unavailable() async {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('App alerts run on the Android app.'),
      ),
    );
  }

  Future<void> _open(PushAlertController push) async {
    try {
      await push.openSettings();
    } on PushUnavailable {
      if (!mounted) return;
      await _unavailable();
    }
  }
}
