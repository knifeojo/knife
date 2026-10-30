import 'package:flutter/services.dart';

class PendingPushApp {
  const PendingPushApp({required this.packageName, required this.label});

  final String packageName;
  final String label;
}

/// Notification access and the per-app yes/no stored on the phone.
abstract class PushPlatform {
  Future<bool> enabled();
  Future<void> openSettings();
  Future<List<PendingPushApp>> pendingApps();
  Future<void> approve(String packageName);
  Future<void> deny(String packageName);
  void listen(void Function() onQueued);
}

class MethodChannelPushPlatform implements PushPlatform {
  MethodChannelPushPlatform({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('ledger/push');

  final MethodChannel _channel;
  void Function()? _onQueued;

  @override
  void listen(void Function() onQueued) {
    _onQueued = onQueued;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'onCaptured') _onQueued?.call();
    });
  }

  @override
  Future<bool> enabled() async {
    try {
      return await _channel.invokeMethod<bool>('enabled') == true;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<void> openSettings() async {
    try {
      await _channel.invokeMethod<bool>('openSettings');
    } on MissingPluginException {
      throw const PushUnavailable();
    }
  }

  @override
  Future<List<PendingPushApp>> pendingApps() async {
    try {
      final raw = await _channel.invokeMethod<List<dynamic>>('pendingApps');
      if (raw == null) return const [];
      return [
        for (final item in raw)
          if (item is Map)
            PendingPushApp(
              packageName: '${item['package'] ?? ''}',
              label: '${item['label'] ?? item['package'] ?? ''}',
            ),
      ].where((app) => app.packageName.isNotEmpty).toList();
    } on MissingPluginException {
      return const [];
    }
  }

  @override
  Future<void> approve(String packageName) =>
      _invoke('approve', packageName);

  @override
  Future<void> deny(String packageName) => _invoke('deny', packageName);

  Future<void> _invoke(String method, String packageName) async {
    try {
      await _channel.invokeMethod<bool>(method, {'package': packageName});
    } on MissingPluginException {
      throw const PushUnavailable();
    }
  }
}

class PushUnavailable implements Exception {
  const PushUnavailable();
}
