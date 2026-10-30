import 'package:flutter/widgets.dart';

import 'push_platform.dart';

class PushAlertScope extends InheritedWidget {
  const PushAlertScope({
    super.key,
    required this.controller,
    required super.child,
  });

  final PushAlertController? controller;

  static PushAlertController? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<PushAlertScope>()
        ?.controller;
  }

  @override
  bool updateShouldNotify(PushAlertScope oldWidget) =>
      controller != oldWidget.controller;
}

/// Notification access and the apps waiting for "Track alerts from App?".
class PushAlertController extends ChangeNotifier {
  PushAlertController({required this.platform}) {
    platform.listen(_onCaptured);
  }

  final PushPlatform platform;
  bool enabled = false;
  List<PendingPushApp> pending = const [];
  bool _closed = false;

  void _onCaptured() {
    if (_closed) return;
    refresh();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }

  Future<void> refresh() async {
    enabled = await platform.enabled();
    pending = await platform.pendingApps();
    if (!_closed) notifyListeners();
  }

  Future<void> approve(String packageName) async {
    await platform.approve(packageName);
    await refresh();
  }

  Future<void> deny(String packageName) async {
    await platform.deny(packageName);
    await refresh();
  }

  Future<void> openSettings() => platform.openSettings();
}
